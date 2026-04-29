/**
 * Unit tests for backend/src/services/fraudDetection.js
 *
 * Covers checkVelocity, checkDailyLimit, and the boundary condition where
 * a transaction exactly meets (but does not exceed) the daily limit.
 */

jest.mock('../db');

const db = require('../db');

// Set env before requiring the module so config constants are picked up
process.env.DAILY_LIMIT_WINDOW_HOURS = '24';
process.env.FRAUD_MAX_TX_PER_WINDOW  = '5';
process.env.FRAUD_DAILY_LIMIT_USD    = '1000';
process.env.XLM_USD_RATE             = '0.10'; // 1 XLM = $0.10 for easy math

const { checkVelocity, checkDailyLimit } = require('../services/fraudDetection');

const WALLET = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

beforeEach(() => jest.clearAllMocks());

// ===========================================================================
// checkVelocity
// ===========================================================================
describe('checkVelocity', () => {
  test('returns false when count is below the threshold (4 of 5)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '4' }] });
    await expect(checkVelocity(WALLET)).resolves.toBe(false);
  });

  test('returns true when count exactly meets the threshold (5 of 5)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '5' }] });
    await expect(checkVelocity(WALLET)).resolves.toBe(true);
  });

  test('returns true when count exceeds the threshold (6 of 5)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '6' }] });
    await expect(checkVelocity(WALLET)).resolves.toBe(true);
  });

  test('queries with the correct wallet address', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    await checkVelocity(WALLET);
    expect(db.query.mock.calls[0][1][0]).toBe(WALLET);
  });

  test('queries with the configured window hours', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    await checkVelocity(WALLET);
    expect(db.query.mock.calls[0][1][1]).toBe(24);
  });
});

// ===========================================================================
// checkDailyLimit
// ===========================================================================
describe('checkDailyLimit', () => {
  // FRAUD_DAILY_LIMIT_USD = 1000, XLM_USD_RATE = 0.10
  // So 1000 USD / 0.10 = 10000 XLM is the limit

  test('returns false when already-sent + new amount is below the limit', async () => {
    // already sent 500 XLM ($50), sending 100 XLM ($10) → $60 total < $1000
    db.query.mockResolvedValueOnce({ rows: [{ total: '500' }] });
    await expect(checkDailyLimit(WALLET, '100', 'XLM')).resolves.toBe(false);
  });

  test('returns false when already-sent + new amount exactly meets the limit (boundary)', async () => {
    // already sent 9000 XLM ($900), sending 1000 XLM ($100) → exactly $1000
    // $1000 is NOT > $1000, so should NOT be blocked
    db.query.mockResolvedValueOnce({ rows: [{ total: '9000' }] });
    await expect(checkDailyLimit(WALLET, '1000', 'XLM')).resolves.toBe(false);
  });

  test('returns true when already-sent + new amount exceeds the limit by 1 unit', async () => {
    // already sent 9000 XLM ($900), sending 1001 XLM ($100.10) → $1000.10 > $1000
    db.query.mockResolvedValueOnce({ rows: [{ total: '9000' }] });
    await expect(checkDailyLimit(WALLET, '1001', 'XLM')).resolves.toBe(true);
  });

  test('returns true when already-sent alone already exceeds the limit', async () => {
    // already sent 11000 XLM ($1100) → any new amount should block
    db.query.mockResolvedValueOnce({ rows: [{ total: '11000' }] });
    await expect(checkDailyLimit(WALLET, '1', 'XLM')).resolves.toBe(true);
  });

  test('handles USDC correctly (1:1 USD)', async () => {
    // already sent $900 USDC, sending $100 USDC → exactly $1000, not blocked
    db.query.mockResolvedValueOnce({ rows: [{ total: '900' }] });
    await expect(checkDailyLimit(WALLET, '100', 'USDC')).resolves.toBe(false);
  });

  test('handles USDC over-limit correctly', async () => {
    // already sent $900 USDC, sending $100.01 → $1000.01 > $1000, blocked
    db.query.mockResolvedValueOnce({ rows: [{ total: '900' }] });
    await expect(checkDailyLimit(WALLET, '100.01', 'USDC')).resolves.toBe(true);
  });

  test('returns false for unknown asset (treated as $0)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    await expect(checkDailyLimit(WALLET, '999999', 'DOGE')).resolves.toBe(false);
  });

  test('handles NULL total from DB (no prior transactions)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: null }] });
    await expect(checkDailyLimit(WALLET, '100', 'XLM')).resolves.toBe(false);
  });

  test('queries with the correct wallet address and window', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    await checkDailyLimit(WALLET, '10', 'XLM');
    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBe(WALLET);
    expect(params[1]).toBe(24);
  });
});
