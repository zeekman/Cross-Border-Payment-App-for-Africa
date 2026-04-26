/**
 * Tests for GET /api/payments/estimate-fee
 */
jest.mock('../services/stellar', () => ({
  sendPayment:       jest.fn(),
  createWallet:      jest.fn(),
  getBalance:        jest.fn(),
  getTransactions:   jest.fn(),
  decryptPrivateKey: jest.fn(),
  fetchFee:          jest.fn()
}));
jest.mock('../db');

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { fetchFee } = require('../services/stellar');

process.env.JWT_SECRET      = 'test-secret';
process.env.ENCRYPTION_KEY  = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK = 'testnet';

const express        = require('express');
const authMiddleware = require('../middleware/auth');
const { estimateFee } = require('../controllers/paymentController');

const app = express();
app.use(express.json());
app.use('/api/payments', authMiddleware, (() => {
  const r = require('express').Router();
  r.get('/estimate-fee', estimateFee);
  return r;
})());

const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET);

describe('GET /api/payments/estimate-fee', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns fee_stroops and fee_xlm', async () => {
    fetchFee.mockResolvedValue(100);

    const res = await request(app)
      .get('/api/payments/estimate-fee')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fee_stroops: 100, fee_xlm: '0.0000100' });
  });

  test('converts stroops to XLM correctly (base fee 200)', async () => {
    fetchFee.mockResolvedValue(200);

    const res = await request(app)
      .get('/api/payments/estimate-fee')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.fee_xlm).toBe('0.0000200');
  });

  test('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/payments/estimate-fee');
    expect(res.status).toBe(401);
  });

  test('propagates Horizon errors as 500', async () => {
    fetchFee.mockRejectedValue(new Error('Horizon unavailable'));

    const app2 = express();
    app2.use(express.json());
    app2.use('/api/payments', authMiddleware, (() => {
      const r = require('express').Router();
      r.get('/estimate-fee', estimateFee);
      return r;
    })());
    // error handler
    app2.use((err, req, res, next) => res.status(500).json({ error: err.message }));

    const res = await request(app2)
      .get('/api/payments/estimate-fee')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Horizon unavailable');
  });
});
