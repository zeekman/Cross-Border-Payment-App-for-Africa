/**
 * Fraud detection service — single source of truth for all send-side checks.
 *
 * Velocity check  : blocks if a wallet sends >= FRAUD_MAX_TX_PER_WINDOW
 *                   transactions within DAILY_LIMIT_WINDOW_HOURS hours.
 *
 * Daily limit     : blocks if the rolling USD-equivalent total sent within
 *                   DAILY_LIMIT_WINDOW_HOURS hours would exceed
 *                   FRAUD_DAILY_LIMIT_USD.
 *
 * Both checks share the same configurable time window so enforcement is
 * consistent and documented in a single place (.env.example).
 */

const db = require('../db');

// ---------------------------------------------------------------------------
// Config — all sourced from env with safe defaults
// ---------------------------------------------------------------------------

/** Rolling window in hours for both velocity and daily-limit checks (default 24 h) */
const WINDOW_HOURS = parseFloat(process.env.DAILY_LIMIT_WINDOW_HOURS || '24');

/** Max transactions allowed within the window before blocking (default 5) */
const MAX_TX_PER_WINDOW = parseInt(process.env.FRAUD_MAX_TX_PER_WINDOW || '5', 10);

/** Max USD-equivalent total sent within the window (default 1000) */
const DAILY_LIMIT_USD = parseFloat(process.env.FRAUD_DAILY_LIMIT_USD || '1000');

/** Approximate XLM/USD rate — mirrors paymentController; replace with live feed in prod */
const XLM_USD_RATE = parseFloat(process.env.XLM_USD_RATE || '0.11');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toUSD(amount, asset) {
  const n = parseFloat(amount);
  if (asset === 'USD' || asset === 'USDC') return n;
  if (asset === 'XLM') return n * XLM_USD_RATE;
  return 0; // unknown assets: don't block
}

// ---------------------------------------------------------------------------
// Exported checks
// ---------------------------------------------------------------------------

/**
 * Velocity check — returns true (suspicious) when the wallet has already
 * sent MAX_TX_PER_WINDOW or more transactions within the rolling window.
 *
 * @param {string} walletAddress
 * @returns {Promise<boolean>}
 */
async function checkVelocity(walletAddress) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FROM transactions
     WHERE sender_wallet = $1
       AND created_at > NOW() - ($2 || ' hours')::INTERVAL`,
    [walletAddress, WINDOW_HOURS]
  );
  return parseInt(rows[0].count, 10) >= MAX_TX_PER_WINDOW;
}

/**
 * Daily limit check — returns true (exceeded) when the rolling USD total
 * already sent within the window plus the new amount would exceed
 * FRAUD_DAILY_LIMIT_USD.
 *
 * @param {string} walletAddress
 * @param {string|number} amount
 * @param {string} asset
 * @returns {Promise<boolean>}
 */
async function checkDailyLimit(walletAddress, amount, asset) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE sender_wallet = $1
       AND status = 'completed'
       AND created_at > NOW() - ($2 || ' hours')::INTERVAL`,
    [walletAddress, WINDOW_HOURS]
  );

  // Sum is in the transaction's native asset — convert to USD for comparison.
  // We store the asset per-row but for simplicity we treat the running total
  // as the same asset as the current payment (conservative approximation).
  const alreadySentUSD = toUSD(rows[0].total, asset);
  const newAmountUSD   = toUSD(amount, asset);

  return (alreadySentUSD + newAmountUSD) > DAILY_LIMIT_USD;
}

module.exports = {
  checkVelocity,
  checkDailyLimit,
  // Exported for tests
  _config: { WINDOW_HOURS, MAX_TX_PER_WINDOW, DAILY_LIMIT_USD },
const db = require('../db');

const FRAUD_RULES = {
  VELOCITY_TRANSACTIONS: {
    limit: parseInt(process.env.FRAUD_VELOCITY_LIMIT || '5'),
    window: parseInt(process.env.FRAUD_VELOCITY_WINDOW || '10') // minutes
  },
  LARGE_TRANSACTION: {
    multiplier: parseFloat(process.env.FRAUD_LARGE_TX_MULTIPLIER || '3')
  },
  UNIQUE_RECIPIENTS: {
    limit: parseInt(process.env.FRAUD_UNIQUE_RECIPIENTS || '5'),
    window: parseInt(process.env.FRAUD_UNIQUE_RECIPIENTS_WINDOW || '60') // minutes
  },
  DAILY_LIMIT: {
    amount: parseFloat(process.env.FRAUD_DAILY_LIMIT_USD || '10000')
  }
};

async function checkVelocity(walletAddress) {
  const result = await db.query(
    `SELECT COUNT(*) FROM transactions
       WHERE sender_wallet = $1 AND created_at > NOW() - ($2 * INTERVAL '1 minute')`,
    [walletAddress, FRAUD_RULES.VELOCITY_TRANSACTIONS.window]
  );
  const count = parseInt(result.rows[0].count);
  if (count >= FRAUD_RULES.VELOCITY_TRANSACTIONS.limit) {
    return { blocked: true, reason: `Exceeded ${FRAUD_RULES.VELOCITY_TRANSACTIONS.limit} transactions in ${FRAUD_RULES.VELOCITY_TRANSACTIONS.window} minutes` };
  }
  return { blocked: false };
}

async function checkLargeTransaction(walletAddress, amount, asset) {
  const result = await db.query(
    `SELECT AVG(amount) as avg_amount FROM transactions
     WHERE sender_wallet = $1 AND asset = $2 AND created_at > NOW() - INTERVAL '30 days'`,
    [walletAddress, asset]
  );

  const avgAmount = parseFloat(result.rows[0]?.avg_amount || 0);
  if (avgAmount > 0 && amount > avgAmount * FRAUD_RULES.LARGE_TRANSACTION.multiplier) {
    return { blocked: true, reason: `Transaction exceeds ${FRAUD_RULES.LARGE_TRANSACTION.multiplier}x average (${avgAmount} ${asset})` };
  }
  return { blocked: false };
}

async function checkUniqueRecipients(walletAddress) {
  const result = await db.query(
    `SELECT COUNT(DISTINCT recipient_wallet) FROM transactions
       WHERE sender_wallet = $1 AND created_at > NOW() - ($2 * INTERVAL '1 minute')`,
    [walletAddress, FRAUD_RULES.UNIQUE_RECIPIENTS.window]
  );
  const count = parseInt(result.rows[0].count);
  if (count >= FRAUD_RULES.UNIQUE_RECIPIENTS.limit) {
    return { blocked: true, reason: `Sending to ${count} unique recipients in ${FRAUD_RULES.UNIQUE_RECIPIENTS.window} minutes` };
  }
  return { blocked: false };
}

async function checkDailyLimit(walletAddress, amount, asset) {
  const XLM_USD_RATE = parseFloat(process.env.XLM_USD_RATE || '0.11');
  const amountUSD = asset === 'USDC' ? parseFloat(amount) : parseFloat(amount) * XLM_USD_RATE;

  const result = await db.query(
    `SELECT SUM(CASE WHEN asset = 'USDC' THEN amount ELSE amount * $2 END) as total_usd
     FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [walletAddress, XLM_USD_RATE]
  );

  const totalUSD = parseFloat(result.rows[0]?.total_usd || 0) + amountUSD;
  if (totalUSD > FRAUD_RULES.DAILY_LIMIT.amount) {
    return { blocked: true, reason: `Daily limit exceeded: $${totalUSD.toFixed(2)} > $${FRAUD_RULES.DAILY_LIMIT.amount}` };
  }
  return { blocked: false };
}

async function checkFraud(walletAddress, amount, asset) {
  const checks = [
    await checkVelocity(walletAddress),
    await checkLargeTransaction(walletAddress, amount, asset),
    await checkUniqueRecipients(walletAddress),
    await checkDailyLimit(walletAddress, amount, asset)
  ];

  const blocked = checks.find(c => c.blocked);
  return blocked || { blocked: false };
}

async function logFraudBlock(walletAddress, reason, amount, asset) {
  await db.query(
    `INSERT INTO fraud_blocks (wallet_address, reason, amount, asset)
     VALUES ($1, $2, $3, $4)`,
    [walletAddress, reason, amount, asset]
  );
}

module.exports = {
  checkFraud,
  logFraudBlock,
  FRAUD_RULES
};
