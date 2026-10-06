'use strict';

jest.mock('../db');
jest.mock('../utils/cache');

const db = require('../db');
const cache = require('../utils/cache');

// fraudDetection must be required AFTER mocks are set up
const fraudDetection = require('../services/fraudDetection');
const { checkFraud, checkVelocity, checkDailyLimit, loadRules } = fraudDetection;

const WALLET = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

beforeEach(() => {
  jest.clearAllMocks();
  cache.get.mockResolvedValue(null); // no cached rules by default
  cache.set.mockResolvedValue(undefined);
  cache.del.mockResolvedValue(undefined);
  // Default: insert to fraud_checks succeeds
  db.query.mockResolvedValue({ rows: [] });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockRules(rules) {
  cache.get.mockResolvedValueOnce(rules);
}

// ---------------------------------------------------------------------------
// Velocity rule
// ---------------------------------------------------------------------------
describe('checkFraud — velocity rule', () => {
  const velocityRule = [{ name: 'test_velocity', rule_type: 'velocity', parameters: { max_transactions: 5, window_minutes: 10 } }];

  test('passes when count is below threshold', async () => {
    mockRules(velocityRule);
    db.query.mockResolvedValueOnce({ rows: [{ count: '4' }] });
    db.query.mockResolvedValue({ rows: [] }); // fraud_checks insert
    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(false);
  });

  test('blocks when count exactly meets threshold', async () => {
    mockRules(velocityRule);
    db.query.mockResolvedValueOnce({ rows: [{ count: '5' }] });
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('test_velocity');
    expect(result.message).toMatch(/5 transactions in 10 minutes/);
  });

  test('blocks when count exceeds threshold', async () => {
    mockRules(velocityRule);
    db.query.mockResolvedValueOnce({ rows: [{ count: '10' }] });
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(true);
  });

  test('passes when count is 0 (no prior transactions)', async () => {
    mockRules(velocityRule);
    db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Amount rule
// ---------------------------------------------------------------------------
describe('checkFraud — amount rule', () => {
  const amountRule = [{ name: 'test_amount', rule_type: 'amount', parameters: { max_usd: 10000 } }];

  test('passes when USDC amount is exactly at limit', async () => {
    mockRules(amountRule);
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '10000', 'USDC');
    expect(result.blocked).toBe(false);
  });

  test('blocks when USDC amount exceeds limit', async () => {
    mockRules(amountRule);
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '10000.01', 'USDC');
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('test_amount');
  });

  test('converts XLM to USD correctly (XLM_USD_RATE=0.10)', async () => {
    process.env.XLM_USD_RATE = '0.10';
    mockRules(amountRule);
    db.query.mockResolvedValue({ rows: [] });
    // 100001 XLM * 0.10 = $10000.10 → exceeds $10000
    const result = await checkFraud(WALLET, '100001', 'XLM');
    expect(result.blocked).toBe(true);
  });

  test('unknown asset treated as $0 — never blocked', async () => {
    mockRules(amountRule);
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '999999', 'DOGE');
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Daily limit rule
// ---------------------------------------------------------------------------
describe('checkFraud — daily_limit rule', () => {
  const dailyRule = [{ name: 'test_daily', rule_type: 'daily_limit', parameters: { max_usd: 1000 } }];

  test('passes when total is below limit', async () => {
    mockRules(dailyRule);
    db.query.mockResolvedValueOnce({ rows: [{ total: '800' }] }); // already sent $800 USDC
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(false);
  });

  test('passes when total exactly equals limit (boundary)', async () => {
    mockRules(dailyRule);
    db.query.mockResolvedValueOnce({ rows: [{ total: '900' }] });
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(false);
  });

  test('blocks when total exceeds limit by 1 cent', async () => {
    mockRules(dailyRule);
    db.query.mockResolvedValueOnce({ rows: [{ total: '900' }] });
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '100.01', 'USDC');
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('test_daily');
    expect(result.message).toMatch(/Daily limit/);
  });

  test('blocks when existing spend alone already exceeds limit', async () => {
    mockRules(dailyRule);
    db.query.mockResolvedValueOnce({ rows: [{ total: '1001' }] });
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '1', 'USDC');
    expect(result.blocked).toBe(true);
  });

  test('handles NULL total from DB gracefully', async () => {
    mockRules(dailyRule);
    db.query.mockResolvedValueOnce({ rows: [{ total: null }] });
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multiple rules — first triggered rule returned
// ---------------------------------------------------------------------------
describe('checkFraud — multiple rules', () => {
  test('returns first triggered rule', async () => {
    const rules = [
      { name: 'velocity_check', rule_type: 'velocity', parameters: { max_transactions: 5, window_minutes: 10 } },
      { name: 'daily_check',    rule_type: 'daily_limit', parameters: { max_usd: 1000 } },
    ];
    mockRules(rules);
    db.query.mockResolvedValueOnce({ rows: [{ count: '10' }] }); // velocity triggers
    db.query.mockResolvedValue({ rows: [] });

    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('velocity_check');
  });

  test('passes if all rules pass', async () => {
    const rules = [
      { name: 'velocity_check', rule_type: 'velocity', parameters: { max_transactions: 5, window_minutes: 10 } },
      { name: 'daily_check',    rule_type: 'daily_limit', parameters: { max_usd: 1000 } },
    ];
    mockRules(rules);
    db.query.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '100' }] });
    db.query.mockResolvedValue({ rows: [] });

    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule loading + cache
// ---------------------------------------------------------------------------
describe('loadRules', () => {
  test('returns cached rules when available', async () => {
    const cachedRules = [{ name: 'cached', rule_type: 'velocity', parameters: {} }];
    cache.get.mockResolvedValueOnce(cachedRules);
    const rules = await loadRules();
    expect(rules).toEqual(cachedRules);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('loads from DB and caches when cache is empty', async () => {
    cache.get.mockResolvedValueOnce(null);
    db.query.mockResolvedValueOnce({ rows: [{ id: '1', name: 'r', rule_type: 'velocity', parameters: {} }] });
    const rules = await loadRules();
    expect(rules).toHaveLength(1);
    expect(cache.set).toHaveBeenCalledWith('fraud:rules', rules, 300);
  });
});

// ---------------------------------------------------------------------------
// Legacy API
// ---------------------------------------------------------------------------
describe('checkVelocity (legacy)', () => {
  beforeEach(() => {
    process.env.DAILY_LIMIT_WINDOW_HOURS = '24';
    process.env.FRAUD_MAX_TX_PER_WINDOW  = '5';
  });

  test('returns false when below threshold', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '4' }] });
    await expect(checkVelocity(WALLET)).resolves.toBe(false);
  });

  test('returns true when at threshold', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '5' }] });
    await expect(checkVelocity(WALLET)).resolves.toBe(true);
  });
});

describe('checkDailyLimit (legacy)', () => {
  beforeEach(() => {
    process.env.DAILY_LIMIT_WINDOW_HOURS = '24';
    process.env.FRAUD_DAILY_LIMIT_USD    = '1000';
    process.env.XLM_USD_RATE             = '0.10';
  });

  test('returns false when below limit (boundary — exactly at limit)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: '9000' }] }); // $900 XLM
    await expect(checkDailyLimit(WALLET, '1000', 'XLM')).resolves.toBe(false); // $100 → $1000 total
  });

  test('returns true when exceeds limit', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: '9000' }] });
    await expect(checkDailyLimit(WALLET, '1001', 'XLM')).resolves.toBe(true);
  });

  test('handles null total', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: null }] });
    await expect(checkDailyLimit(WALLET, '100', 'XLM')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BE-033: shadow/staging mode
// ---------------------------------------------------------------------------
describe('checkFraud — shadow mode (BE-033)', () => {
  const shadowVelocityRule = [{
    name: 'candidate_velocity', rule_type: 'velocity', mode: 'shadow',
    parameters: { max_transactions: 5, window_minutes: 10 },
  }];

  test('a triggered shadow rule does NOT block the transaction', async () => {
    mockRules(shadowVelocityRule);
    db.query.mockResolvedValueOnce({ rows: [{ count: '10' }] }); // way over threshold
    db.query.mockResolvedValue({ rows: [] }); // fraud_checks insert
    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(false);
  });

  test('logs a shadow_blocked outcome with would_block=true and rule_mode=shadow', async () => {
    mockRules(shadowVelocityRule);
    db.query.mockResolvedValueOnce({ rows: [{ count: '10' }] });
    db.query.mockResolvedValue({ rows: [] });
    await checkFraud(WALLET, '100', 'USDC');

    const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO fraud_checks'));
    expect(insertCall).toBeTruthy();
    const [, params] = insertCall;
    // [rule_name, rule_type, outcome, payment_id, wallet_address, metadata, rule_mode, would_block]
    expect(params[2]).toBe('shadow_blocked');
    expect(params[6]).toBe('shadow');
    expect(params[7]).toBe(true);
  });

  test('an active rule still blocks as before (regression check)', async () => {
    const activeRule = [{
      name: 'active_velocity', rule_type: 'velocity', mode: 'active',
      parameters: { max_transactions: 5, window_minutes: 10 },
    }];
    mockRules(activeRule);
    db.query.mockResolvedValueOnce({ rows: [{ count: '10' }] });
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '100', 'USDC');
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('active_velocity');
  });

  test('a shadow rule that does not trigger falls through to later active rules', async () => {
    const rules = [
      { name: 'shadow_amount', rule_type: 'amount', mode: 'shadow', parameters: { max_usd: 999999 } },
      { name: 'active_amount', rule_type: 'amount', mode: 'active', parameters: { max_usd: 10 } },
    ];
    mockRules(rules);
    db.query.mockResolvedValue({ rows: [] });
    const result = await checkFraud(WALLET, '1000', 'USDC');
    expect(result.blocked).toBe(true);
    expect(result.rule).toBe('active_amount');
  });
});

describe('getShadowRuleReport (BE-033)', () => {
  test('aggregates would-block vs would-pass counts per shadow rule', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { rule_name: 'candidate_velocity', would_block_count: '3', would_pass_count: '17', total_evaluations: '20' },
      ],
    });
    const { getShadowRuleReport } = fraudDetection;
    const report = await getShadowRuleReport(7);
    expect(report).toEqual([
      {
        rule_name: 'candidate_velocity',
        would_block_count: 3,
        would_pass_count: 17,
        total_evaluations: 20,
        would_block_rate: 0.15,
      },
    ]);
  });
});
