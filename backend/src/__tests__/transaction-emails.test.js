/**
 * Tests for transaction receipt email notifications.
 *
 * Verifies that sendTransactionEmail is called with the correct arguments
 * for both the sender and the registered recipient after a successful payment.
 *
 * db.query call order for POST /api/payments/send (low-value, no idempotency header):
 *   1. Wallet lookup      SELECT public_key, encrypted_secret_key FROM wallets
 *   2. Fraud check        SELECT COUNT(*) FROM transactions
 *   3. Insert tx          INSERT INTO transactions
 *   4. Sender email       SELECT email FROM users WHERE id = $1
 *   5. Recipient email    SELECT u.email FROM users u JOIN wallets w ...
 *
 * Emails are fired asynchronously (fire-and-forget), so we flush the
 * microtask queue with setImmediate before asserting.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('../db');
jest.mock('../services/stellar', () => ({
  sendPayment:       jest.fn(),
  createWallet:      jest.fn(),
  getBalance:        jest.fn(),
  getTransactions:   jest.fn(),
  decryptPrivateKey: jest.fn()
}));
jest.mock('../services/email', () => ({
  sendVerificationEmail:  jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendTransactionEmail:   jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../services/webhook', () => ({
  deliver: jest.fn().mockResolvedValue(undefined),
  sign:    jest.fn()
}));

global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db');
const { sendPayment } = require('../services/stellar');
const { sendTransactionEmail } = require('../services/email');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
process.env.JWT_SECRET        = 'test-jwt-secret';
process.env.ENCRYPTION_KEY    = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK   = 'testnet';
process.env.KYC_THRESHOLD_USD = '100';
process.env.XLM_USD_RATE      = '0.11';

const express        = require('express');
const StellarSdk     = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const idempotency    = require('../middleware/idempotency');
const { send }       = require('../controllers/paymentController');
const { body, validationResult } = require('express-validator');
const paymentSendValidators = require('../validators/paymentSendValidators');

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
  paymentSendValidators,
  [
    body('recipient_address')
      .notEmpty().withMessage('Recipient address is required')
      .custom((value) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(value)) {
          throw new Error('Invalid Stellar wallet address');
        }
        return true;
      }),
    body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
    body('asset').optional().isIn(['XLM', 'USDC', 'NGN', 'GHS', 'KES'])
  ],
  validate,
  idempotency,
  send
);

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const JWT_SECRET       = 'test-jwt-secret';
const USER_ID          = uuidv4();
const SENDER_KEY       = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const RECIPIENT_KEY    = 'GCUB4U3E5AXUY2OJOFKQGDL2ZIEAFHAXNERCZ4EEKF2J6IFIK7KYYPUI';
const ENCRYPTED_SECRET = 'deadbeef:deadbeef01234567deadbeef01234567deadbeef01234567';
const FAKE_TX_HASH     = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const FAKE_LEDGER      = 99;
const SENDER_EMAIL     = 'sender@example.com';
const RECIPIENT_EMAIL  = 'recipient@example.com';

const WALLET_ROW = { public_key: SENDER_KEY, encrypted_secret_key: ENCRYPTED_SECRET };

function makeToken(userId = USER_ID) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

/** Flush async fire-and-forget promises before asserting on email calls. */
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const { deliver: webhookDeliver } = require('../services/webhook');

beforeEach(() => {
  jest.resetAllMocks();
  sendPayment.mockResolvedValue({ transactionHash: FAKE_TX_HASH, ledger: FAKE_LEDGER });
  // Default fallback for any db.query call not explicitly mocked
  db.query.mockResolvedValue({ rows: [] });
  // Webhook deliver must return a Promise so .catch() doesn't throw
  webhookDeliver.mockResolvedValue(undefined);
  // Email service must return a Promise (reset clears the factory default)
  sendTransactionEmail.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock the db.query sequence for a successful low-value payment where
 * both sender and recipient are registered AfriPay users.
 *
 * Call order (webhook is mocked, so no webhook db.query calls):
 *   1. wallet lookup
 *   2. fraud check
 *   3. INSERT tx
 *   4. sender email lookup
 *   5. recipient email lookup
 */
function mockHappyPathBothUsers() {
  db.query
    .mockResolvedValueOnce({ rows: [WALLET_ROW] })                             // wallet lookup
    .mockResolvedValueOnce({ rows: [{ count: '0' }] })                         // fraud check
    .mockResolvedValueOnce({ rows: [] })                                       // INSERT tx
    .mockResolvedValueOnce({ rows: [{ email: SENDER_EMAIL }] })                // sender email
    .mockResolvedValueOnce({ rows: [{ email: RECIPIENT_EMAIL }] });            // recipient email
}

/**
 * Mock where the recipient is NOT a registered AfriPay user.
 */
function mockHappyPathSenderOnly() {
  db.query
    .mockResolvedValueOnce({ rows: [WALLET_ROW] })
    .mockResolvedValueOnce({ rows: [{ count: '0' }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ email: SENDER_EMAIL }] })
    .mockResolvedValueOnce({ rows: [] }); // recipient not found
}

// ===========================================================================
// Email sent to sender
// ===========================================================================
describe('transaction emails — sender', () => {
  test('sends a "sent" email to the sender after a successful payment', async () => {
    mockHappyPathBothUsers();

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    expect(res.status).toBe(200);
    await flushAsync();

    const sentCall = sendTransactionEmail.mock.calls.find(
      ([, type]) => type === 'sent'
    );
    expect(sentCall).toBeDefined();
    expect(sentCall[0]).toBe(SENDER_EMAIL);
    expect(sentCall[1]).toBe('sent');
  });

  test('"sent" email contains correct transaction data', async () => {
    mockHappyPathBothUsers();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM', memo: 'school fees' });

    await flushAsync();

    const sentCall = sendTransactionEmail.mock.calls.find(([, type]) => type === 'sent');
    expect(sentCall).toBeDefined();
    const txData = sentCall[2];
    expect(txData.amount).toBe('10');
    expect(txData.asset).toBe('XLM');
    expect(txData.senderAddress).toBe(SENDER_KEY);
    expect(txData.recipientAddress).toBe(RECIPIENT_KEY);
    expect(txData.memo).toBe('school fees');
    expect(txData.txHash).toBe(FAKE_TX_HASH);
  });

  test('"sent" email memo is null when no memo is provided', async () => {
    mockHappyPathBothUsers();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '5', asset: 'XLM' });

    await flushAsync();

    const sentCall = sendTransactionEmail.mock.calls.find(([, type]) => type === 'sent');
    expect(sentCall[2].memo).toBeNull();
  });
});

// ===========================================================================
// Email sent to recipient
// ===========================================================================
describe('transaction emails — recipient', () => {
  test('sends a "received" email to a registered recipient', async () => {
    mockHappyPathBothUsers();

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    expect(res.status).toBe(200);
    await flushAsync();

    const receivedCall = sendTransactionEmail.mock.calls.find(
      ([, type]) => type === 'received'
    );
    expect(receivedCall).toBeDefined();
    expect(receivedCall[0]).toBe(RECIPIENT_EMAIL);
    expect(receivedCall[1]).toBe('received');
  });

  test('"received" email contains correct transaction data', async () => {
    mockHappyPathBothUsers();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '25', asset: 'USDC', memo: 'rent' });

    await flushAsync();

    const receivedCall = sendTransactionEmail.mock.calls.find(([, type]) => type === 'received');
    expect(receivedCall).toBeDefined();
    const txData = receivedCall[2];
    expect(txData.amount).toBe('25');
    expect(txData.asset).toBe('USDC');
    expect(txData.senderAddress).toBe(SENDER_KEY);
    expect(txData.recipientAddress).toBe(RECIPIENT_KEY);
    expect(txData.memo).toBe('rent');
    expect(txData.txHash).toBe(FAKE_TX_HASH);
  });

  test('does NOT send a "received" email when recipient is not a registered user', async () => {
    mockHappyPathSenderOnly();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    await flushAsync();

    const receivedCall = sendTransactionEmail.mock.calls.find(([, type]) => type === 'received');
    expect(receivedCall).toBeUndefined();
  });
});

// ===========================================================================
// Emails are non-blocking
// ===========================================================================
describe('transaction emails — non-blocking', () => {
  test('payment response is returned even if sender email lookup fails', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('DB connection lost')) // sender email lookup fails
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    // Payment still succeeds
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Payment sent successfully');
  });

  test('payment response is returned even if sendTransactionEmail throws', async () => {
    mockHappyPathBothUsers();
    sendTransactionEmail.mockRejectedValue(new Error('SMTP timeout'));

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Payment sent successfully');
  });

  test('emails are NOT sent when the payment fails', async () => {
    const stellarErr = new Error('tx_bad_seq');
    stellarErr.response = { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } };
    sendPayment.mockRejectedValueOnce(stellarErr);

    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    await flushAsync();

    expect(res.status).toBe(400);
    expect(sendTransactionEmail).not.toHaveBeenCalled();
  });
});
