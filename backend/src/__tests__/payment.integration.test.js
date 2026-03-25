/**
 * Integration tests for POST /api/payments/send and GET /api/payments/history
 *
 * Drives the full Express middleware stack via supertest (auth → validation →
 * idempotency → controller). Both the database and Stellar service are mocked
 * so no real network or DB connections are required.
 *
 * db.query call order for POST /api/payments/send (no idempotency header):
 *   1. KYC check          SELECT kyc_status FROM users
 *   2. Wallet lookup      SELECT public_key, encrypted_secret_key FROM wallets
 *   3. Fraud check        SELECT COUNT(*) FROM transactions
 *   4. Insert tx          INSERT INTO transactions
 *
 * db.query call order for GET /api/payments/history:
 *   1. Wallet lookup      SELECT public_key FROM wallets
 *   2. Count              SELECT COUNT(*) FROM transactions
 *   3. Records            SELECT ... FROM transactions
 */

// ---------------------------------------------------------------------------
// Mocks — declared before any require() so Jest hoisting works correctly
// ---------------------------------------------------------------------------
jest.mock('../db');
jest.mock('../services/stellar', () => ({
  sendPayment:       jest.fn(),
  createWallet:      jest.fn(),
  getBalance:        jest.fn(),
  getTransactions:   jest.fn(),
  decryptPrivateKey: jest.fn()
}));

global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db');
const { sendPayment } = require('../services/stellar');

// ---------------------------------------------------------------------------
// Build the Express app once — no resetModules so mocks stay active
// ---------------------------------------------------------------------------
process.env.JWT_SECRET        = 'test-jwt-secret';
process.env.ENCRYPTION_KEY    = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK   = 'testnet';
process.env.KYC_THRESHOLD_USD = '100';
process.env.XLM_USD_RATE      = '0.11';

const express      = require('express');
const StellarSdk   = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const idempotency  = require('../middleware/idempotency');
const { send, history } = require('../controllers/paymentController');
const { query: qv, validationResult } = require('express-validator');
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

app.get(
  '/api/payments/history',
  authMiddleware,
  [
    qv('page').optional().isInt({ min: 1 }),
    qv('limit').optional().isInt({ min: 1, max: 100 })
  ],
  validate,
  history
);

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const JWT_SECRET       = 'test-jwt-secret';
const USER_ID          = uuidv4();
const SENDER_KEY       = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const RECIPIENT_KEY    = 'GCUB4U3E5AXUY2OJOFKQGDL2ZIEAFHAXNERCZ4EEKF2J6IFIK7KYYPUI';
const ENCRYPTED_SECRET = 'deadbeef:deadbeef01234567deadbeef01234567deadbeef01234567';
const FAKE_TX_HASH     = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const FAKE_LEDGER      = 99;

const WALLET_ROW = { public_key: SENDER_KEY, encrypted_secret_key: ENCRYPTED_SECRET };

function makeToken(userId = USER_ID) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

// ---------------------------------------------------------------------------
// db.query sequence helpers
// (no idempotency header → idempotency middleware is a no-op)
//
// KYC query is ONLY issued when estimatedUSD >= KYC_THRESHOLD_USD (100).
//   Low-value  (e.g. 10 XLM  = $1.10):  wallet → fraud → INSERT
//   High-value (e.g. 1000 XLM = $110):  KYC → wallet → fraud → INSERT
// ---------------------------------------------------------------------------

/**
 * Happy-path send for LOW-value amounts (no KYC query):
 *   call 1 — wallet lookup → WALLET_ROW
 *   call 2 — fraud check   → count (default '0')
 *   call 3+ — INSERT + anything else → []
 */
function mockSendHappyPath({ fraudCount = '0' } = {}) {
  db.query
    .mockResolvedValueOnce({ rows: [WALLET_ROW] })
    .mockResolvedValueOnce({ rows: [{ count: fraudCount }] })
    .mockResolvedValue({ rows: [] });
}

/**
 * Happy-path send for HIGH-value amounts (KYC query fires first):
 *   call 1 — KYC check     → verified
 *   call 2 — wallet lookup → WALLET_ROW
 *   call 3 — fraud check   → count (default '0')
 *   call 4+ — INSERT + anything else → []
 */
function mockSendHappyPathHighValue({ fraudCount = '0' } = {}) {
  db.query
    .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified' }] })
    .mockResolvedValueOnce({ rows: [WALLET_ROW] })
    .mockResolvedValueOnce({ rows: [{ count: fraudCount }] })
    .mockResolvedValue({ rows: [] });
}

/**
 * Happy-path history:
 *   call 1 — wallet lookup → SENDER_KEY
 *   call 2 — COUNT(*)      → txRows.length
 *   call 3 — SELECT rows   → txRows
 */
function mockHistoryHappyPath(txRows = []) {
  db.query
    .mockResolvedValueOnce({ rows: [{ public_key: SENDER_KEY }] })
    .mockResolvedValueOnce({ rows: [{ count: String(txRows.length) }] })
    .mockResolvedValueOnce({ rows: txRows });
}

function makeTxRow(overrides = {}) {
  return {
    id:               uuidv4(),
    sender_wallet:    SENDER_KEY,
    recipient_wallet: RECIPIENT_KEY,
    amount:           '10.0000000',
    asset:            'XLM',
    memo:             null,
    memo_type:        null,
    tx_hash:          FAKE_TX_HASH,
    status:           'completed',
    created_at:       new Date().toISOString(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.resetAllMocks();
  sendPayment.mockResolvedValue({ transactionHash: FAKE_TX_HASH, ledger: FAKE_LEDGER });
  db.query.mockResolvedValue({ rows: [] });
});

// ===========================================================================
// POST /api/payments/send — authentication
// ===========================================================================
describe('POST /api/payments/send — authentication', () => {
  test('returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .send({ recipient_address: RECIPIENT_KEY, amount: '10' });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(sendPayment).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('returns 401 for a malformed token', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', 'Bearer not.a.valid.jwt')
      .send({ recipient_address: RECIPIENT_KEY, amount: '10' });

    expect(res.status).toBe(401);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 401 for a token signed with the wrong secret', async () => {
    const badToken = jwt.sign({ userId: USER_ID }, 'wrong-secret');
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${badToken}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10' });

    expect(res.status).toBe(401);
    expect(sendPayment).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/payments/send — input validation
// ===========================================================================
describe('POST /api/payments/send — input validation', () => {
  test('returns 400 when recipient_address is missing', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ amount: '10' });

    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 400 when amount is zero', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '0' });

    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 400 when amount is negative', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '-5' });

    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 400 when asset is not in the allowed list', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'BTC' });

    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 400 when memo_type is id but memo is missing', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', memo_type: 'id' });

    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 400 when memo_type is id but memo is not numeric', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        recipient_address: RECIPIENT_KEY,
        amount: '10',
        memo: 'not-a-number',
        memo_type: 'id'
      });

    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 400 when memo_type is hash but memo is not 64 hex chars', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        recipient_address: RECIPIENT_KEY,
        amount: '10',
        memo: 'deadbeef',
        memo_type: 'hash'
      });

    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/payments/send — Stellar address validation
// ===========================================================================
describe('POST /api/payments/send — Stellar address validation', () => {
  const VALID_STELLAR_ADDRESS = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

  test('accepts a valid Stellar public key and proceeds to business logic', async () => {
    mockSendHappyPath();

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    // Validation passes — reaches controller (200 or business-logic error, not 400)
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(200);
  });

  test('returns 400 with user-friendly message for a malformed address', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: 'NOTAVALIDSTELLARKEY', amount: '10', asset: 'XLM' });

    expect(res.status).toBe(400);
    const messages = res.body.errors.map((e) => e.msg);
    expect(messages).toContain('Invalid Stellar wallet address');
    expect(sendPayment).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('returns 400 for an address that is wrong length but looks base32', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: 'GABC123SHORT', amount: '10', asset: 'XLM' });

    expect(res.status).toBe(400);
    const messages = res.body.errors.map((e) => e.msg);
    expect(messages).toContain('Invalid Stellar wallet address');
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 400 for an empty recipient_address', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: '', amount: '10', asset: 'XLM' });

    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('does not reach DB or Stellar service when address is invalid', async () => {
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: 'bad-address', amount: '10', asset: 'XLM' });

    expect(res.status).toBe(400);
    expect(sendPayment).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ===========================================================================
describe('POST /api/payments/send — success', () => {
  test('returns 200 with correct transaction shape', async () => {
    mockSendHappyPath();

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Payment sent successfully');
    expect(res.body.transaction).toMatchObject({
      tx_hash:   FAKE_TX_HASH,
      ledger:    FAKE_LEDGER,
      amount:    '10',
      asset:     'XLM',
      recipient: RECIPIENT_KEY
    });
    expect(res.body.transaction.id).toBeDefined();
  });

  test('calls sendPayment with correct arguments', async () => {
    mockSendHappyPath();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '5', asset: 'XLM', memo: 'school fees' });

    expect(sendPayment).toHaveBeenCalledTimes(1);
    expect(sendPayment).toHaveBeenCalledWith(expect.objectContaining({
      senderPublicKey:    SENDER_KEY,
      encryptedSecretKey: ENCRYPTED_SECRET,
      recipientPublicKey: RECIPIENT_KEY,
      amount:             '5',
      asset:              'XLM',
      memo:               'school fees',
      memoType:           'text'
    }));
  });

  test('calls sendPayment with memoType id for exchange-style memos', async () => {
    mockSendHappyPath();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        recipient_address: RECIPIENT_KEY,
        amount: '1',
        asset: 'XLM',
        memo: '987654321',
        memo_type: 'id'
      });

    expect(sendPayment).toHaveBeenCalledWith(expect.objectContaining({
      memo: '987654321',
      memoType: 'id'
    }));
  });

  test('persists transaction to DB with correct fields', async () => {
    mockSendHappyPath();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    const insertCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO transactions')
    );
    expect(insertCall).toBeDefined();
    const params = insertCall[1];
    // [txId, sender_wallet, recipient_wallet, amount, asset, memo, memo_type, tx_hash]
    expect(params[1]).toBe(SENDER_KEY);
    expect(params[2]).toBe(RECIPIENT_KEY);
    expect(params[3]).toBe('10');
    expect(params[4]).toBe('XLM');
    expect(params[7]).toBe(FAKE_TX_HASH);
  });

  test('stores null memo when memo is not provided', async () => {
    mockSendHappyPath();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    const insertCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO transactions')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][5]).toBeNull();
    expect(insertCall[1][6]).toBeNull();
  });
});

// ===========================================================================
// POST /api/payments/send — business logic errors
// ===========================================================================
describe('POST /api/payments/send — business logic', () => {
  test('returns 400 when sending to own wallet', async () => {
    // Low-value (10 XLM = $1.10) — no KYC query, wallet is first call
    db.query.mockResolvedValueOnce({ rows: [WALLET_ROW] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: SENDER_KEY, amount: '10', asset: 'XLM' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own wallet/i);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 404 when wallet is not found', async () => {
    // Low-value — wallet lookup is first call, returns empty
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    expect(res.status).toBe(404);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 403 when KYC is required for high-value transaction', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'unverified' }] });

    // 1000 XLM * 0.11 = $110 > $100 threshold
    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '1000', asset: 'XLM' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('KYC_REQUIRED');
    expect(sendPayment).not.toHaveBeenCalled();
  });

  test('returns 400 and does not persist when Stellar returns an error', async () => {
    const stellarErr = new Error('tx_bad_seq');
    stellarErr.response = { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } };
    sendPayment.mockRejectedValueOnce(stellarErr);

    // Low-value: wallet → fraud → (sendPayment throws, no INSERT)
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    expect(res.status).toBe(400);

    const insertCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO transactions')
    );
    expect(insertCall).toBeUndefined();
  });
});

// ===========================================================================
// POST /api/payments/send — fraud protection
// ===========================================================================
describe('POST /api/payments/send — fraud protection', () => {
  test('blocks the 6th transaction within 10 minutes with 429', async () => {
    // Low-value: wallet → fraud (count=5 → blocked)
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '1', asset: 'XLM' });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/transaction limit/i);
    expect(sendPayment).not.toHaveBeenCalled();

    const insertCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO transactions')
    );
    expect(insertCall).toBeUndefined();
  });

  test('allows the 5th transaction — count=4 is below threshold', async () => {
    mockSendHappyPath({ fraudCount: '4' });

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '1', asset: 'XLM' });

    expect(res.status).toBe(200);
    expect(sendPayment).toHaveBeenCalledTimes(1);
  });

  test('fraud check queries the correct sender wallet address', async () => {
    mockSendHappyPath();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '1', asset: 'XLM' });

    const fraudCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('COUNT(*)') && sql.includes('sender_wallet')
    );
    expect(fraudCall).toBeDefined();
    expect(fraudCall[1][0]).toBe(SENDER_KEY);
  });

  test('fraud check window is scoped to 10 minutes', async () => {
    mockSendHappyPath();

    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '1', asset: 'XLM' });

    const fraudCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('COUNT(*)') && sql.includes('sender_wallet')
    );
    expect(fraudCall).toBeDefined();
    expect(fraudCall[0]).toMatch(/10 minutes/i);
  });
});

// ===========================================================================
// GET /api/payments/history — authentication
// ===========================================================================
describe('GET /api/payments/history — authentication', () => {
  test('returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/api/payments/history');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('returns 401 for an invalid token', async () => {
    const res = await request(app)
      .get('/api/payments/history')
      .set('Authorization', 'Bearer bad.token.value');

    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GET /api/payments/history — success
// ===========================================================================
describe('GET /api/payments/history — success', () => {
  test('returns 200 with empty list for a wallet with no transactions', async () => {
    mockHistoryHappyPath([]);

    const res = await request(app)
      .get('/api/payments/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.pages).toBe(0);
  });

  test('returns sent transaction with direction=sent', async () => {
    const txRow = makeTxRow();
    mockHistoryHappyPath([txRow]);

    const res = await request(app)
      .get('/api/payments/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    const tx = res.body.transactions[0];
    expect(tx.direction).toBe('sent');
    expect(tx.tx_hash).toBe(FAKE_TX_HASH);
    expect(tx.sender_wallet).toBe(SENDER_KEY);
    expect(tx.recipient_wallet).toBe(RECIPIENT_KEY);
    expect(tx.amount).toBe('10.0000000');
    expect(tx.asset).toBe('XLM');
    expect(tx.status).toBe('completed');
    expect(tx.id).toBeDefined();
    expect(tx.created_at).toBeDefined();
  });

  test('returns received transaction with direction=received', async () => {
    const txRow = makeTxRow({
      sender_wallet:    RECIPIENT_KEY,
      recipient_wallet: SENDER_KEY,
      tx_hash:          'recv' + FAKE_TX_HASH.slice(4)
    });
    mockHistoryHappyPath([txRow]);

    const res = await request(app)
      .get('/api/payments/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions[0].direction).toBe('received');
  });

  test('returns both sent and received with correct directions', async () => {
    const rows = [
      makeTxRow({ tx_hash: 'sent' + FAKE_TX_HASH.slice(4) }),
      makeTxRow({ sender_wallet: RECIPIENT_KEY, recipient_wallet: SENDER_KEY, tx_hash: 'recv' + FAKE_TX_HASH.slice(4) })
    ];
    mockHistoryHappyPath(rows);

    const res = await request(app)
      .get('/api/payments/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const directions = res.body.transactions.map(t => t.direction).sort();
    expect(directions).toEqual(['received', 'sent']);
  });

  test('returns correct pagination metadata', async () => {
    const rows = [makeTxRow({ tx_hash: 'h1' + FAKE_TX_HASH.slice(2) }), makeTxRow({ tx_hash: 'h2' + FAKE_TX_HASH.slice(2) })];
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_KEY }] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })
      .mockResolvedValueOnce({ rows });

    const res = await request(app)
      .get('/api/payments/history?page=2&limit=2')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(2);
    expect(res.body.total).toBe(5);
    expect(res.body.pages).toBe(3);
    expect(res.body.transactions).toHaveLength(2);
  });

  test('returns 404 when wallet is not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/payments/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// GET /api/payments/history — input validation
// ===========================================================================
describe('GET /api/payments/history — validation', () => {
  test('returns 400 for page=0', async () => {
    const res = await request(app)
      .get('/api/payments/history?page=0')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(400);
  });

  test('returns 400 for limit=0', async () => {
    const res = await request(app)
      .get('/api/payments/history?limit=0')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(400);
  });

  test('returns 400 for limit exceeding 100', async () => {
    const res = await request(app)
      .get('/api/payments/history?limit=101')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Security
// ===========================================================================
describe('security — response data integrity', () => {
  test('history response never contains sensitive key fields', async () => {
    mockHistoryHappyPath([makeTxRow()]);

    const res = await request(app)
      .get('/api/payments/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('encrypted_secret_key');
    expect(body).not.toContain('password_hash');
  });

  test('send response never contains encrypted_secret_key', async () => {
    mockSendHappyPath();

    const res = await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('encrypted_secret_key');
    expect(body).not.toContain(ENCRYPTED_SECRET);
  });

  test('no real Stellar/Horizon network calls are made', async () => {
    mockSendHappyPath();
    await request(app)
      .post('/api/payments/send')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_address: RECIPIENT_KEY, amount: '10', asset: 'XLM' });

    const realCalls = (global.fetch.mock?.calls ?? []).filter(
      ([url]) => url && (url.includes('horizon') || url.includes('stellar.org'))
    );
    expect(realCalls).toHaveLength(0);
  });
});
