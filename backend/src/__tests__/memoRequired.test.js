/**
 * Integration tests for paymentController memo validation.
 *
 * Covers:
 *  - paymentController returns 422 when memo is required but missing
 *  - paymentController proceeds normally when memo is required and provided
 *  - paymentController proceeds normally when memo is not required
 *  - Directory fetch failure does not block payment (fail-open)
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before any require()
// ---------------------------------------------------------------------------
jest.mock('../db');
jest.mock('../services/stellar', () => ({
  sendPayment: jest.fn(),
  sendPathPayment: jest.fn(),
  findPaymentPath: jest.fn(),
  fetchFee: jest.fn(),
  resolveFederationAddress: jest.fn(),
}));
jest.mock('../services/fraudDetection', () => ({
  checkFraud: jest.fn(),
  logFraudBlock: jest.fn(),
}));
jest.mock('../utils/cache', () => ({ del: jest.fn(), get: jest.fn(), set: jest.fn() }));
jest.mock('../services/webhook', () => ({ deliver: jest.fn() }));
jest.mock('../services/memoRequired', () => ({ isMemoRequired: jest.fn() }));

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
process.env.JWT_SECRET        = 'test-secret';
process.env.ENCRYPTION_KEY    = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK   = 'testnet';
process.env.KYC_THRESHOLD_USD = '999999'; // disable KYC for these tests
process.env.XLM_USD_RATE      = '0.11';
process.env.DAILY_SEND_LIMIT  = '999999';

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const express  = require('express');
const db       = require('../db');
const { sendPayment } = require('../services/stellar');
const { isMemoRequired } = require('../services/memoRequired');
const { checkFraud } = require('../services/fraudDetection');
const webhook  = require('../services/webhook');
const cache    = require('../utils/cache');

// Valid Stellar Ed25519 public keys (verified via StrKey.isValidEd25519PublicKey)
const MEMO_REQUIRED_ADDRESS = 'GCDENRHBHC6YNAVKWHGYREZXWURXQYSZRXBBLOHUFAV4RHOHSGVLGMMG';
const REGULAR_ADDRESS       = 'GDS3MNUP3WNLOU2VE5GKWSQFUW55L7P3HFS3EXEZEXMW4RVJUFFOAKLQ';
const SENDER_ADDRESS        = 'GDBXMDP5SOA5KJ2IT673D5TTN3HPXCBKINHU75H5HJSNUNRJQQVKEB5I';

// ---------------------------------------------------------------------------
// paymentController integration tests
// ---------------------------------------------------------------------------
describe('paymentController memo validation', () => {
  let app;

  beforeAll(() => {
    const authMiddleware = require('../middleware/auth');
    const idempotency    = require('../middleware/idempotency');
    const { send }       = require('../controllers/paymentController');
    const paymentSendValidators = require('../validators/paymentSendValidators');
    const { validationResult }  = require('express-validator');

    const validate = (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      next();
    };

    app = express();
    app.use(express.json());
    app.post('/api/payments/send', authMiddleware, paymentSendValidators, validate, idempotency, send);
    app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  });

  beforeEach(() => {
    // Reset queued mock responses and re-apply default implementations
    jest.resetAllMocks();
    checkFraud.mockResolvedValue({ blocked: false });
    webhook.deliver.mockResolvedValue(undefined);
    cache.del.mockResolvedValue(undefined);
  });

  function makeToken() {
    return jwt.sign({ userId: 1 }, process.env.JWT_SECRET);
  }

  function mockDbForSend() {
    db.query
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'unverified' }] })   // KYC
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_ADDRESS, encrypted_secret_key: 'enc' }] }) // wallet
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })                  // daily limit
      .mockResolvedValueOnce({ rows: [] });                               // insert tx
  }

  test('returns 422 when memo is required but not provided', async () => {
    isMemoRequired.mockResolvedValue(true);
    db.query
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'unverified' }] })
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_ADDRESS, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: MEMO_REQUIRED_ADDRESS, amount: 10, asset: 'XLM' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MEMO_REQUIRED');
    expect(res.body.error).toMatch(/memo/i);
  });

  test('proceeds normally when memo is required and provided', async () => {
    isMemoRequired.mockResolvedValue(true);
    mockDbForSend();
    sendPayment.mockResolvedValue({ transactionHash: 'abc123', ledger: 1, type: 'payment' });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: MEMO_REQUIRED_ADDRESS, amount: 10, asset: 'XLM', memo: '12345' });

    expect(res.status).toBe(200);
    expect(res.body.transaction.tx_hash).toBe('abc123');
  });

  test('proceeds normally when memo is not required and no memo provided', async () => {
    isMemoRequired.mockResolvedValue(false);
    mockDbForSend();
    sendPayment.mockResolvedValue({ transactionHash: 'def456', ledger: 2, type: 'payment' });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: REGULAR_ADDRESS, amount: 5, asset: 'XLM' });

    expect(res.status).toBe(200);
    expect(res.body.transaction.tx_hash).toBe('def456');
  });

  test('directory fetch failure does not block payment (fail-open)', async () => {
    // When directory is unreachable, isMemoRequired returns false → payment proceeds
    isMemoRequired.mockResolvedValue(false);
    mockDbForSend();
    sendPayment.mockResolvedValue({ transactionHash: 'ghi789', ledger: 3, type: 'payment' });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: REGULAR_ADDRESS, amount: 5, asset: 'XLM' });

    expect(res.status).toBe(200);
  });
});
