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
jest.mock('../src/services/memoRequired', () => ({
  isMemoRequired: jest.fn(),
}));
jest.mock('../src/services/fraudDetection', () => ({
  checkFraud: jest.fn(),
  logFraudBlock: jest.fn(),
}));
jest.mock('../src/services/webhook', () => ({
  deliver: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/utils/cache', () => ({
  del: jest.fn(() => Promise.resolve()),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/db');
const authMiddleware = require('../src/middleware/auth');
const idempotency = require('../src/middleware/idempotency');
const paymentBatchValidators = require('../src/validators/paymentBatchValidators');
const { validationResult } = require('express-validator');
const { sendBatch } = require('../src/controllers/paymentController');
const { sendBatchPayment, validateBatchRecipient } = require('../src/services/stellar');
const { isMemoRequired } = require('../src/services/memoRequired');
const { checkFraud } = require('../src/services/fraudDetection');

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
const INVALID_RECIPIENT = 'GDV3A7XU2I7GQFLSM7ORWPH4YJTL7SIEO76DJ5OJW3YBAJBRVUGPIL2B';

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
  isMemoRequired.mockResolvedValue(false);
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
    recipients: [{ index: 0, recipientPublicKey: VALID_RECIPIENT, amount: '10' }],
  }));
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
