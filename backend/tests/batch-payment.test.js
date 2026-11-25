jest.mock('../src/db');
jest.mock('../src/services/stellar', () => ({
  sendBatchPayment: jest.fn(),
  validateBatchRecipient: jest.fn(),
  resolveFederationAddress: jest.fn(),
  sendPayment: jest.fn(),
  sendPathPayment: jest.fn(),
  findPaymentPath: jest.fn(),
  fetchFee: jest.fn(),
}));
jest.mock('../src/services/fees', () => ({
  buildFeeBreakdown: jest.fn(async (gross, asset) => {
    const fee = Number((Number(gross) * 250 / 10000).toFixed(7));
    const net = Number((Number(gross) - fee).toFixed(7));
    return {
      gross_amount: Number(gross),
      gross_amount_usdc: Number(gross),
      platform_fee_bps: 250,
      platform_fee_amount: fee,
      platform_fee_usdc: fee,
      net_amount: net,
      net_amount_usdc: net,
      asset,
    };
  }),
  collectPlatformFee: jest.fn(),
}));
jest.mock('../src/services/memoRequired', () => ({
  isMemoRequired: jest.fn(),
}));
jest.mock('../src/services/fraudDetection', () => ({
  checkVelocity: jest.fn(),
  checkDailyLimit: jest.fn(),
  checkFraud: jest.fn(),
  logFraudBlock: jest.fn(),
}));
jest.mock('../src/services/webhook', () => ({
  deliver: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/utils/cache', () => ({
  get: jest.fn(),
  set: jest.fn(() => Promise.resolve()),
  del: jest.fn(() => Promise.resolve()),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../src/db');
const authMiddleware = require('../src/middleware/auth');
const idempotency = require('../src/middleware/idempotency');
const paymentBatchValidators = require('../src/validators/paymentBatchValidators');
const { validationResult } = require('express-validator');
const { sendBatch } = require('../src/controllers/paymentController');
const { sendBatchPayment, validateBatchRecipient } = require('../src/services/stellar');
const { isMemoRequired } = require('../src/services/memoRequired');
const { checkVelocity, checkDailyLimit, checkFraud } = require('../src/services/fraudDetection');
const cache = require('../src/utils/cache');

process.env.JWT_SECRET = 'batch-test-secret';
process.env.KYC_THRESHOLD_USD = '100';
process.env.XLM_USD_RATE = '0.11';

const app = express();
app.use(express.json());

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

app.post('/api/payments/batch', authMiddleware, paymentBatchValidators, validate, idempotency, sendBatch);
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const USER_ID = 'test-user-id';
const TOKEN = jwt.sign({ userId: USER_ID }, process.env.JWT_SECRET, { expiresIn: '1h' });
const SENDER = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const VALID_RECIPIENT = 'GCUB4U3E5AXUY2OJOFKQGDL2ZIEAFHAXNERCZ4EEKF2J6IFIK7KYYPUI';
const INVALID_RECIPIENT = StellarSdk.Keypair.random().publicKey();

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
  cache.get.mockResolvedValue([
    { asset: 'XLM', available_balance: '1000' },
    { asset: 'USDC', available_balance: '1000' },
  ]);
  isMemoRequired.mockResolvedValue(false);
  checkVelocity.mockResolvedValue(false);
  checkDailyLimit.mockResolvedValue(false);
  checkFraud.mockResolvedValue({ blocked: false });
  validateBatchRecipient.mockResolvedValue({ recipientPublicKey: VALID_RECIPIENT });
  sendBatchPayment.mockResolvedValue({
    transactionHash: 'batch_hash_123',
    ledger: 12,
    operationCount: 1,
  });
});

test('returns a per-recipient breakdown when some rows fail validation', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'enc' }] })
    .mockResolvedValueOnce({ rows: [{ total: '0' }] })
    .mockResolvedValue({ rows: [] });

  validateBatchRecipient
    .mockResolvedValueOnce({ recipientPublicKey: VALID_RECIPIENT })
    .mockRejectedValueOnce(Object.assign(new Error('Recipient has no USDC trustline.'), { status: 400 }));

  const response = await request(app)
    .post('/api/payments/batch')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
      asset: 'USDC',
      recipients: [
        { recipient_address: VALID_RECIPIENT, amount: '10' },
        { recipient_address: INVALID_RECIPIENT, amount: '20' },
      ],
    });

  expect(response.status).toBe(200);
  expect(sendBatchPayment).toHaveBeenCalledWith(expect.objectContaining({
    asset: 'USDC',
    recipients: [expect.objectContaining({ index: 0, recipientPublicKey: VALID_RECIPIENT, amount: 9.75 })],
  }));
  const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO transactions'));
  expect(insertCall[1][10]).toBe(0.25);
  expect(JSON.parse(insertCall[1][11])).toMatchObject({ platform_fee_amount: 0.25, net_amount: 9.75 });
  expect(response.body.summary).toEqual({
    total: 2,
    submitted: 1,
    successful: 1,
    failed: 1,
  });
  expect(response.body.results).toEqual([
    expect.objectContaining({
      index: 0,
      recipient_address: VALID_RECIPIENT,
      status: 'success',
      tx_hash: 'batch_hash_123',
      ledger: 12,
    }),
    expect.objectContaining({
      index: 1,
      recipient_address: INVALID_RECIPIENT,
      status: 'failed',
      error: 'Recipient has no USDC trustline.',
    }),
  ]);
});

test('rejects an underfunded batch before submitting to Horizon', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'enc' }] })
    .mockResolvedValueOnce({ rows: [{ total: '0' }] });
  cache.get.mockResolvedValue([{ asset: 'USDC', available_balance: '5' }]);

  const response = await request(app)
    .post('/api/payments/batch')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
      asset: 'USDC',
      recipients: [{ recipient_address: VALID_RECIPIENT, amount: '10' }],
    });

  expect(response.status).toBe(400);
  expect(response.body.code).toBe('INSUFFICIENT_BALANCE');
  expect(sendBatchPayment).not.toHaveBeenCalled();
});

test('checks memo-required status concurrently for a 20-recipient batch', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'enc' }] })
    .mockResolvedValueOnce({ rows: [{ total: '0' }] });

  let activeLookups = 0;
  let maxActiveLookups = 0;
  isMemoRequired.mockImplementation(async () => {
    activeLookups += 1;
    maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeLookups -= 1;
    return false;
  });

  const recipients = Array.from({ length: 20 }, () => ({
    recipient_address: StellarSdk.Keypair.random().publicKey(),
    amount: '1',
  }));
  const response = await request(app)
    .post('/api/payments/batch')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({ asset: 'USDC', recipients });

  expect(response.status).toBe(200);
  expect(isMemoRequired).toHaveBeenCalledTimes(20);
  expect(maxActiveLookups).toBeGreaterThan(1);
  expect(maxActiveLookups).toBeLessThanOrEqual(5);
});

test('returns 400 when every recipient fails validation', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'enc' }] })
    .mockResolvedValueOnce({ rows: [{ total: '0' }] })
    .mockResolvedValue({ rows: [] });

  validateBatchRecipient.mockRejectedValue(Object.assign(new Error('Recipient account does not exist on the Stellar network.'), {
    status: 400,
  }));

  const response = await request(app)
    .post('/api/payments/batch')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
      asset: 'XLM',
      recipients: [{ recipient_address: INVALID_RECIPIENT, amount: '5' }],
    });

  expect(response.status).toBe(400);
  expect(sendBatchPayment).not.toHaveBeenCalled();
  expect(response.body.summary).toEqual({
    total: 1,
    submitted: 0,
    successful: 0,
    failed: 1,
  });
  expect(response.body.results[0]).toEqual(expect.objectContaining({
    status: 'failed',
    error: 'Recipient account does not exist on the Stellar network.',
  }));
});
