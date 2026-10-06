'use strict';

const db = require('../db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const RULES_CACHE_KEY = 'fraud:rules';
const RULES_CACHE_TTL = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Rule loading
// ---------------------------------------------------------------------------

async function loadRules() {
  const cached = await cache.get(RULES_CACHE_KEY);
  if (cached) return cached;

  const { rows } = await db.query(
    `SELECT id, name, rule_type, parameters, mode FROM fraud_rules WHERE is_active = true`
  );
  await cache.set(RULES_CACHE_KEY, rows, RULES_CACHE_TTL);
  return rows;
}

async function invalidateRulesCache() {
  await cache.del(RULES_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Rule evaluators
// ---------------------------------------------------------------------------

async function evaluateVelocity(rule, walletAddress) {
  const { max_transactions, window_minutes } = rule.parameters;
  const { rows } = await db.query(
    `SELECT COUNT(*) FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - ($2 * INTERVAL '1 minute')`,
    [walletAddress, window_minutes]
  );
  const count = parseInt(rows[0].count, 10);
  if (count >= max_transactions) {
    return {
      triggered: true,
      message: `Exceeded ${max_transactions} transactions in ${window_minutes} minutes`,
    };
  }
  return { triggered: false };
}

async function evaluateAmount(rule, _walletAddress, amount, asset) {
  const { max_usd } = rule.parameters;
  const usdValue = toUsd(amount, asset);
  if (usdValue > max_usd) {
    return {
      triggered: true,
      message: `Transaction amount $${usdValue.toFixed(2)} exceeds single-transaction limit of $${max_usd}`,
    };
  }
  return { triggered: false };
}

async function evaluateDailyLimit(rule, walletAddress, amount, asset) {
  const { max_usd } = rule.parameters;
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - INTERVAL '24 hours' AND status != 'cancelled'`,
    [walletAddress]
  );
  const sentUsd = toUsd(rows[0].total, asset);
  const newUsd = toUsd(amount, asset);
  if (sentUsd + newUsd > max_usd) {
    return {
      triggered: true,
      message: `Daily limit of $${max_usd} would be exceeded ($${(sentUsd + newUsd).toFixed(2)} total)`,
    };
  }
  return { triggered: false };
}

function toUsd(amount, asset) {
  const n = parseFloat(amount) || 0;
  if (asset === 'USDC') return n;
  if (asset === 'XLM') return n * parseFloat(process.env.XLM_USD_RATE || '0.10');
  return 0;
}

const EVALUATORS = {
  velocity: evaluateVelocity,
  amount: evaluateAmount,
  daily_limit: evaluateDailyLimit,
};

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

/**
 * Evaluate all active fraud rules against a payment.
 * Returns { blocked, rule, message } where blocked=false if no rule triggers.
 */
async function checkFraud(walletAddress, amount, asset, paymentId = null) {
  let rules;
  try {
    rules = await loadRules();
  } catch (err) {
    logger.warn('Failed to load fraud rules, falling back to pass-through', { error: err.message });
    return { blocked: false };
  }

  for (const rule of rules) {
    const evaluator = EVALUATORS[rule.rule_type];
    if (!evaluator) continue;

    let result;
    try {
      result = await evaluator(rule, walletAddress, amount, asset);
    } catch (err) {
      logger.warn('Fraud rule evaluation error', { rule: rule.name, error: err.message });
      continue;
    }

    // BE-033: shadow-mode rules are evaluated and logged exactly like active
    // rules, but never actually block — `would_block` records what the rule
    // *would* have decided, so a false-positive rate can be computed before
    // promoting the rule to 'active'. See getShadowRuleReport().
    const isShadow = rule.mode === 'shadow';
    const outcome = isShadow
      ? (result.triggered ? 'shadow_blocked' : 'shadow_passed')
      : (result.triggered ? 'blocked' : 'passed');

    // Log to audit table (fire-and-forget)
    db.query(
      `INSERT INTO fraud_checks (rule_name, rule_type, outcome, payment_id, wallet_address, metadata, rule_mode, would_block)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [rule.name, rule.rule_type, outcome, paymentId || null, walletAddress,
       JSON.stringify({ amount, asset, ...result }), rule.mode || 'active', result.triggered]
    ).catch(e => logger.warn('fraud_checks insert failed', { error: e.message }));

    if (result.triggered) {
      if (isShadow) {
        logger.info('Shadow fraud rule would have blocked transaction', {
          rule: rule.name, walletAddress, message: result.message,
        });
        continue;
      }
      return { blocked: true, rule: rule.name, message: result.message };
    }
  }

  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Legacy compatibility (checkVelocity / checkDailyLimit used by old tests)
// ---------------------------------------------------------------------------

async function checkVelocity(walletAddress) {
  const windowHours = parseInt(process.env.DAILY_LIMIT_WINDOW_HOURS || '24', 10);
  const maxTx = parseInt(process.env.FRAUD_MAX_TX_PER_WINDOW || '5', 10);
  const { rows } = await db.query(
    `SELECT COUNT(*) FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - ($2 * INTERVAL '1 hour')`,
    [walletAddress, windowHours]
  );
  return parseInt(rows[0].count, 10) >= maxTx;
}

async function checkDailyLimit(walletAddress, amount, asset) {
  const limitUsd = parseFloat(process.env.FRAUD_DAILY_LIMIT_USD || '1000');
  const windowHours = parseInt(process.env.DAILY_LIMIT_WINDOW_HOURS || '24', 10);
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - ($2 * INTERVAL '1 hour')`,
    [walletAddress, windowHours]
  );
  const sentUsd = toUsd(rows[0].total, asset);
  const newUsd = toUsd(amount, asset);
  return sentUsd + newUsd > limitUsd;
}

async function logFraudBlock(walletAddress, reason, amount, asset) {
  await db.query(
    `INSERT INTO fraud_blocks (wallet_address, reason, amount, asset)
     VALUES ($1, $2, $3, $4)`,
    [walletAddress, reason, amount, asset]
  );
}

// ---------------------------------------------------------------------------
// Shadow-mode reporting (BE-033)
// ---------------------------------------------------------------------------

/**
 * Compare shadow-rule outcomes against real traffic, so an admin can decide
 * whether a rule is safe to promote from 'shadow' to 'active' mode.
 * Returns per-rule counts and would-be false-positive rate is left to the
 * caller/report UI to interpret against known-legitimate transactions —
 * this returns the raw trigger rate for that purpose.
 */
async function getShadowRuleReport(sinceDays = 7) {
  const { rows } = await db.query(
    `SELECT rule_name,
            COUNT(*) FILTER (WHERE would_block = true) AS would_block_count,
            COUNT(*) FILTER (WHERE would_block = false) AS would_pass_count,
            COUNT(*) AS total_evaluations
     FROM fraud_checks
     WHERE rule_mode = 'shadow' AND created_at > NOW() - ($1 * INTERVAL '1 day')
     GROUP BY rule_name
     ORDER BY rule_name`,
    [sinceDays]
  );

  return rows.map((r) => ({
    rule_name: r.rule_name,
    would_block_count: parseInt(r.would_block_count, 10),
    would_pass_count: parseInt(r.would_pass_count, 10),
    total_evaluations: parseInt(r.total_evaluations, 10),
    would_block_rate: r.total_evaluations > 0
      ? parseInt(r.would_block_count, 10) / parseInt(r.total_evaluations, 10)
      : 0,
  }));
}

module.exports = {
  checkFraud,
  checkVelocity,
  checkDailyLimit,
  logFraudBlock,
  loadRules,
  invalidateRulesCache,
  getShadowRuleReport,
};
