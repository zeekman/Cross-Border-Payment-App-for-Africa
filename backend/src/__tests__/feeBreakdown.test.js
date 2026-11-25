'use strict';

/**
 * Tests for:
 *   - buildFeeBreakdown (via estimateFees endpoint)
 *   - GET /api/payments/estimate-fees
 *   - GET /api/payments/:id
 */

jest.mock('../services/stellar', () => ({
  sendPayment: jest.fn(),
  createWallet: jest.fn(),
  getBalance: jest.fn(),
  getTransactions: jest.fn(),
  decryptPrivateKey: jest.fn(),
  fetchFee: jest.fn(),
  fetchFeeStats: jest.fn(),
  sendBatchPayment: jest.fn(),
  sendPathPayment: jest.fn(),
  findPaymentPath: jest.fn(),
  validateBatchRecipient: jest.fn(),
  findReceivePath: jest.fn(),
  sendStrictReceivePathPayment: jest.fn(),
  resolveFederationAddress: jest.fn(),
}));
jest.mock('../db');
jest.mock('../utils/cache', () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() }));
jest.mock('../services/webhook', () => ({ deliver: jest.fn() }));
jest.mock('../services/fraudDetection', () => ({
  checkVelocity: jest.fn().mockResolvedValue(false),
  checkDailyLimit: jest.fn().mockResolvedValue(false),
  checkFraud: jest.fn().mockResolvedValue({ blocked: false }),
  logFraudBlock: jest.fn(),
}));
jest.mock('../services/loyaltyToken', () => ({ mintPoints: jest.fn() }));
jest.mock('../services/feeDistributor', () => ({ depositFee: jest.fn() }));
jest.mock('../services/memoRequired', () => ({ isMemoRequired: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/email', () => ({ sendTransactionEmail: jest.fn() }));
jest.mock('../controllers/referralController', () => ({ awardReferralCredit: jest.fn() }));

process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK = 'testnet';
process.env.PLATFORM_FEE_BPS = '250';

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { fetchFee } = require('../services/stellar');
const db = require('../db');

const { estimateFees, getPaymentById } = require('../controllers/paymentController');

const app = express();
app.use(express.json());
// Inject user directly — avoids JWT secret timing issues in tests
app.use((req, _res, next) => { req.user = { userId: 'u1' }; next(); });
app.use('/api/payments', (() => {
  const r = require('express').Router();
  r.get('/estimate-fees', estimateFees);
  r.get('/:id', getPaymentById);
  return r;
})());
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

// Separate app to test actual 401
const authMiddleware = require('../middleware/auth');
const appWithAuth = express();
appWithAuth.use(express.json());
appWithAuth.use('/api/payments', authMiddleware, (() => {
  const r = require('express').Router();
  r.get('/estimate-fees', estimateFees);
  return r;
})());

const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET);

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// GET /api/payments/estimate-fees
// ---------------------------------------------------------------------------
describe('GET /api/payments/estimate-fees', () => {
  test('returns fee_breakdown for USDC amount', async () => {
    fetchFee.mockResolvedValue(100);

    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=100&asset=USDC');

    expect(res.status).toBe(200);
    const fb = res.body.fee_breakdown;
    expect(fb.gross_amount_usdc).toBe(100);
    expect(fb.platform_fee_bps).toBe(250);
    expect(fb.platform_fee_usdc).toBeCloseTo(2.5, 5);
    expect(fb.net_amount_usdc).toBeCloseTo(97.5, 5);
    expect(fb.stellar_base_fee_xlm).toBeCloseTo(0.00001, 7);
    expect(fb.asset).toBe('USDC');
  });

  test('stellar_base_fee_xlm is null when fetchFee fails', async () => {
    fetchFee.mockRejectedValue(new Error('Horizon down'));

    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=50&asset=XLM');

    expect(res.status).toBe(200);
    expect(res.body.fee_breakdown.stellar_base_fee_xlm).toBeNull();
  });

  test('defaults asset to USDC when not provided', async () => {
    fetchFee.mockResolvedValue(100);

    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=200');

    expect(res.status).toBe(200);
    expect(res.body.fee_breakdown.asset).toBe('USDC');
  });

  test('returns 400 when amount is missing', async () => {
    const res = await request(app)
      .get('/api/payments/estimate-fees?asset=USDC');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/i);
  });

  test('returns 400 when amount is zero', async () => {
    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=0&asset=USDC');

    expect(res.status).toBe(400);
  });

  test('returns 400 for unsupported asset', async () => {
    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=10&asset=FAKE');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/asset/i);
  });

  test('returns 401 without auth token', async () => {
    const res = await request(appWithAuth).get('/api/payments/estimate-fees?amount=10');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// buildFeeBreakdown math (platform_fee precision)
// ---------------------------------------------------------------------------
describe('fee_breakdown math', () => {
  test('platform_fee_usdc rounded to 7 decimal places', async () => {
    fetchFee.mockResolvedValue(100);

    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=1&asset=USDC')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // 1 * 250/10000 = 0.025 — check 7dp precision
    const fee = res.body.fee_breakdown.platform_fee_usdc;
    expect(fee.toString()).toMatch(/^\d+(\.\d{1,7})?$/);
    expect(fee).toBe(0.025);
  });

  test('net_amount_usdc = gross_amount_usdc - platform_fee_usdc', async () => {
    fetchFee.mockResolvedValue(100);

    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=400&asset=USDC')
      .set('Authorization', `Bearer ${token}`);

    const fb = res.body.fee_breakdown;
    expect(parseFloat((fb.gross_amount_usdc - fb.platform_fee_usdc).toFixed(7))).toBe(fb.net_amount_usdc);
  });
});

// ---------------------------------------------------------------------------
// GET /api/payments/:id
// ---------------------------------------------------------------------------
const TX_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const WALLET = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZC1B0K7I9BYJY8JFP2P4';

const mockTx = {
  id: TX_ID,
  sender_wallet: WALLET,
  recipient_wallet: 'GDZOS5NQWLRGFD7NVJYEBQNBSCQPXLBVS3Z6AZ4XKQKQFABN4FKFPV5',
  amount: '100.0000000',
  asset: 'USDC',
  memo: null,
  memo_type: null,
  tx_hash: 'abc123',
  status: 'completed',
  created_at: new Date('2024-01-01T00:00:00Z'),
  ledger_close_time: new Date('2024-01-01T00:00:01Z'),
  fee_breakdown: {
    gross_amount_usdc: 100,
    platform_fee_bps: 250,
    platform_fee_usdc: 2.5,
    stellar_base_fee_xlm: 0.00001,
    net_amount_usdc: 97.5,
    asset: 'USDC',
  },
};

describe('GET /api/payments/:id', () => {
  test('returns payment with fee_breakdown for sender', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: WALLET }] }) // wallets query
      .mockResolvedValueOnce({ rows: [mockTx] });                 // transaction query

    const res = await request(app).get(`/api/payments/${TX_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(TX_ID);
    expect(res.body.direction).toBe('sent');
    const fb = res.body.fee_breakdown;
    expect(fb.gross_amount_usdc).toBe(100);
    expect(fb.platform_fee_usdc).toBe(2.5);
    expect(fb.net_amount_usdc).toBe(97.5);
    expect(fb.stellar_base_fee_xlm).toBe(0.00001);
    expect(fb.platform_fee_bps).toBe(250);
  });

  test('returns 404 when transaction not found', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: WALLET }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/api/payments/${TX_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns 404 when wallet not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/api/payments/${TX_ID}`);

    expect(res.status).toBe(404);
  });

  test('direction is received for recipient', async () => {
    const recipientWallet = 'GDZOS5NQWLRGFD7NVJYEBQNBSCQPXLBVS3Z6AZ4XKQKQFABN4FKFPV5';
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: recipientWallet }] })
      .mockResolvedValueOnce({ rows: [mockTx] });

    const res = await request(app).get(`/api/payments/${TX_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.direction).toBe('received');
  });
});
