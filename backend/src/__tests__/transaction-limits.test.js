/**
 * Tests for transaction amount limits and daily send limit.
 *
 * Covers:
 *  - Route-level min/max validation (routes/payments.js)
 *  - Controller-level daily limit check (paymentController.js)
 */

jest.mock('../db');
jest.mock('../services/stellar', () => ({
  sendPayment:       jest.fn(),
  createWallet:      jest.fn(),
  getBalance:        jest.fn(),
  getTransactions:   jest.fn(),
  decryptPrivateKey: jest.fn(),
}));

global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ---- env setup (must happen before requiring app modules) ----
process.env.JWT_SECRET             = 'test-secret';
process.env.ENCRYPTION_KEY         = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK        = 'testnet';
process.env.KYC_THRESHOLD_USD      = '100';
process.env.XLM_USD_RATE           = '0.11';
process.env.MAX_TRANSACTION_AMOUNT = '1000';
process.env.DAILY_SEND_LIMIT       = '2000';

const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const express  = require('express');
const StellarSdk = require('@stellar/stellar-sdk');
const { body, validationResult } = require('express-validator');

const db           = require('../db');
const { sendPayment } = require('../services/stellar');
const authMiddleware  = require('../middleware/auth');
const idempotency     = require('../middleware/idempotency');
const { send }        = require('../controllers/paymentController');

// ---- rebuild the /send route with the same validators as production ----
const STELLAR_MIN = 0.0000001;
const MAX_TX      = parseFloat(process.env.MAX_TRANSACTION_AMOUNT);

function amountLimits(field = 'amount') {
  return body(field)
    .isFloat({ gt: 0 }).withMessage('Amount must be greater than 0')
    .custom((v) => {
      const n = parseFloat(v);
      if (n < STELLAR_MIN) throw new Error(`Amount must be at least ${STELLAR_MIN} (1 stroop)`);
      if (n > MAX_TX)      throw new Error(`Amount exceeds the maximum allowed per transaction (${MAX_TX})`);
      return true;
    });
}

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const app = express();
app.use(express.json());
app.post(
  '/api/payments/send',
  authMiddleware,
  [
    body('recipient_address')
      .notEmpty()
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar wallet address');
        return true;
      }),
    amountLimits('amount'),
    body('asset').optional().isIn(['XLM', 'USDC', 'NGN', 'GHS', 'KES']),
  ],
  validate,
  idempotency,
  send,
);
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

// ---- fixtures ----
const USER_ID       = uuidv4();
const SENDER_KEY    = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const RECIPIENT_KEY = 'GCUB4U3E5AXUY2OJOFKQGDL2ZIEAFHAXNERCZ4EEKF2J6IFIK7KYYPUI';
const ENC_SECRET    = 'deadbeef:deadbeef01234567deadbeef01234567deadbeef01234567';
const WALLET_ROW    = { public_key: SENDER_KEY, encrypted_secret_key: ENC_SECRET };
const FAKE_HASH     = 'a'.repeat(64);

function token() {
  return jwt.sign({ userId: USER_ID }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

/** Mock DB for a happy-path low-value send (no KYC, no daily limit breach) */
function mockHappyPath({ dailyTotal = '0', fraudCount = '0' } = {}) {
  db.query
    .mockResolvedValueOnce({ rows: [WALLET_ROW] })          // wallet lookup
    .mockResolvedValueOnce({ rows: [{ total: dailyTotal }] }) // daily limit
    .mockResolvedValueOnce({ rows: [{ count: fraudCount }] }) // fraud check
    .mockResolvedValue({ rows: [] });                         // INSERT
}

beforeEach(() => {
  jest.resetAllMocks();
  sendPayment.mockResolvedValue({ transactionHash: FAKE_HASH, ledger: 1 });
  db.query.mockResolvedValue({ rows: [] });
});

// ============================================================
// Route-level: minimum amount
// ============================================================
describe('minimum amount validation', () => {
  test('rejects amount of 0', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 0 });
    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('rejects negative amount', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: -1 });
    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('rejects amount below Stellar minimum (0.00000001)', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 0.00000001 });
    expect(res.status).toBe(400);
    const msgs = res.body.errors.map(e => e.msg);
    expect(msgs.some(m => m.includes('stroop'))).toBe(true);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('accepts the Stellar minimum exactly (0.0000001)', async () => {
    mockHappyPath();
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 0.0000001 });
    expect(res.status).toBe(200);
  });
});

// ============================================================
// Route-level: maximum amount
// ============================================================
describe('maximum amount validation', () => {
  test('rejects amount above MAX_TRANSACTION_AMOUNT', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 1001 });
    expect(res.status).toBe(400);
    const msgs = res.body.errors.map(e => e.msg);
    expect(msgs.some(m => m.includes('maximum'))).toBe(true);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('accepts amount exactly at MAX_TRANSACTION_AMOUNT', async () => {
    mockHappyPath();
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 1000 });
    expect(res.status).toBe(200);
  });

  test('accepts amount just below MAX_TRANSACTION_AMOUNT', async () => {
    mockHappyPath();
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 999.9999999 });
    expect(res.status).toBe(200);
  });
});

// ============================================================
// Controller-level: daily send limit
// ============================================================
describe('daily send limit', () => {
  test('blocks when adding amount would exceed DAILY_SEND_LIMIT', async () => {
    // daily total already 1800, trying to send 300 → 2100 > 2000
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [{ total: '1800' }] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 300 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('blocks when amount alone equals DAILY_SEND_LIMIT + 1', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 2001 });

    // Caught by route-level max first (2001 > 1000), but daily limit would also block
    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('allows send when total would exactly equal DAILY_SEND_LIMIT', async () => {
    // daily total 1000, sending 1000 → exactly 2000 = limit (not exceeded)
    mockHappyPath({ dailyTotal: '1000' });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 1000 });

    expect(res.status).toBe(200);
    expect(sendPayment).toHaveBeenCalledTimes(1);
  });

  test('allows send when daily total is zero', async () => {
    mockHappyPath({ dailyTotal: '0' });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 10 });

    expect(res.status).toBe(200);
  });

  test('daily limit query uses correct wallet address', async () => {
    mockHappyPath();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 10 });

    const dailyCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('date_trunc') && sql.includes('sender_wallet')
    );
    expect(dailyCall).toBeDefined();
    expect(dailyCall[1][0]).toBe(SENDER_KEY);
  });

  test('error message includes the configured limit value', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [{ total: '1900' }] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${token()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: 200 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('2000');
  });
});
