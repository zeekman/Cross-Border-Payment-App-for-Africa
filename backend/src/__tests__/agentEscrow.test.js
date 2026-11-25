/**
 * Integration tests for the agent-escrow API
 *
 * Routes tested:
 *   GET  /api/escrow                              — list escrows for the caller
 *   GET  /api/escrow/:id                          — fetch a single escrow (IDOR-protected)
 *   POST /api/escrow/create                       — sender creates escrow
 *   POST /api/escrow/:id/confirm (and /confirm-payout) — agent confirms payout
 *   POST /api/escrow/:id/cancel                    — sender cancels escrow
 *   POST /api/contracts/escrow/:id/partial-release — sender releases part of escrow
 *
 * Database, Soroban service, email, audit, compliance and cache layers are mocked.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before any require() that pulls them in
// ---------------------------------------------------------------------------
jest.mock('../db');
jest.mock('../services/agentEscrow');
jest.mock('../services/email');
jest.mock('../services/audit');
jest.mock('../utils/cache');
jest.mock('../controllers/sessionController');
jest.mock('../controllers/paymentController', () => ({
  ensureKycIfNeeded: jest.fn(),
  amlRescreenForPayment: jest.fn(),
  dailyLimitExceeded: jest.fn().mockResolvedValue(false),
  checkFraud: jest.fn().mockResolvedValue({ blocked: false }),
  logFraudBlock: jest.fn(),
  estimateUSDValue: jest.fn().mockReturnValue(100),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { createEscrow, confirmPayout, cancelEscrow } = require('../services/agentEscrow');
const { enqueueEmail } = require('../services/email');
const audit = require('../services/audit');
const { isJtiBlacklisted } = require('../controllers/sessionController');
const {
  ensureKycIfNeeded,
  amlRescreenForPayment,
  dailyLimitExceeded,
  checkFraud,
} = require('../controllers/paymentController');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK = 'testnet';

const escrowRouter = require('../routes/agentEscrow');
const contractsRouter = require('../routes/contracts');

const app = express();
app.use(express.json());
app.use('/api/escrow', escrowRouter);
app.use('/api/contracts', contractsRouter);
// Error handler so unhandled rejections don't hang supertest
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const JWT_SECRET = 'test-jwt-secret';

const SENDER_ID = uuidv4();
const AGENT_ID = uuidv4();
const OTHER_ID = uuidv4();

const SENDER_WALLET = 'GDX67TGRQWDLLYCKTGNHSGZILUKORO6N222AHB3F7RH4CH4L3DYNPH3F';
const AGENT_WALLET = 'GC2I4ITILLDWL44SEL4ZE5K2UKDGW4FS4DLL2WZJMD3KS4SM6QIHIO5V';
const RECIPIENT_WALLET = 'GDT6HIVNMMKXKFMS7G7RWGME4LPAFYQDDMS6GSP6FBLPSZEOJF7TIPDD';
const OTHER_WALLET = 'GAOJ5CUQGVEIZBU3JUOQZRCQEATCIMHCDWAL45CEZDAEJZA3OYV4M4GH';

const ENC_SECRET = 'deadbeef:deadbeef01234567deadbeef01234567deadbeef01234567';
const FAKE_TX_HASH = 'a'.repeat(64);

const VALID_AGENT_WALLET = 'GCEEWK3NONEDF3RDRZLNESBEOWI3XXPYHQYHR2DKIBMYWYKMIJHLSVHI';
const VALID_RECIPIENT = 'GDV77HOBIFW7CD3VIDPP6VWTAHU2VJAYOSHDHIBMFET2HGLWCI4JGQZK';

const ESCROW_ID = uuidv4();
const CONTRACT_ESCROW_ID = '42';

/**
 * Build a signed JWT for a test user.
 * `walletAddress` is included in the payload so cancel/partialRelease
 * can compare against `req.user.walletAddress`.
 */
function makeToken(userId, role = 'user', walletAddress = null) {
  return jwt.sign({ userId, role, walletAddress }, JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Create a fake escrow row with sensible defaults.
 */
function escrowRow(overrides = {}) {
  return {
    id: ESCROW_ID,
    contract_escrow_id: CONTRACT_ESCROW_ID,
    sender_wallet: SENDER_WALLET,
    recipient_wallet: RECIPIENT_WALLET,
    agent_wallet: AGENT_WALLET,
    amount: '100.0000000',
    asset: 'USDC',
    fee_bps: 250,
    status: 'pending',
    tx_hash: FAKE_TX_HASH,
    confirm_tx_hash: null,
    released_amount: 0,
    created_at: new Date(),
    confirmed_at: null,
    ...overrides,
  };
}

/**
 * Set up a fresh `db.query` mock that handles the auth middleware's
 * `SELECT is_suspended …` query automatically and returns caller-supplied
 * results for other SQL patterns.
 *
 * @param {Object<string, {rows: Array}>} overrides  Map of SQL-substring → result.
 *        Each key is matched against the SQL string; the first match wins.
 *        Auth-check SQL is always handled internally and never overridden.
 */
function setupDb(overrides = {}) {
  // Re-create the mock function to clear any leftover mockResolvedValueOnce queue
  db.query = jest.fn().mockImplementation((sql) => {
    // Auth middleware: user suspension check — always return non-suspended
    if (typeof sql === 'string' && sql.includes('is_suspended')) {
      return Promise.resolve({ rows: [{ is_suspended: false, suspension_reason: null }] });
    }
    // Check caller-supplied overrides
    for (const [pattern, value] of Object.entries(overrides)) {
      if (typeof sql === 'string' && sql.includes(pattern)) {
        return Promise.resolve(value);
      }
    }
    // Default: empty rows
    return Promise.resolve({ rows: [] });
  });
}

// ---------------------------------------------------------------------------
// Global mock defaults
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();

  // Fresh db.query mock with auth check handled by default
  setupDb();

  // Compliance checks pass by default
  ensureKycIfNeeded.mockResolvedValue(undefined);
  amlRescreenForPayment.mockResolvedValue(undefined);
  dailyLimitExceeded.mockResolvedValue(false);
  checkFraud.mockResolvedValue({ blocked: false });

  // Soroban service defaults
  createEscrow.mockResolvedValue({ escrowId: CONTRACT_ESCROW_ID, txHash: FAKE_TX_HASH });
  confirmPayout.mockResolvedValue({ txHash: FAKE_TX_HASH });
  cancelEscrow.mockResolvedValue({ txHash: FAKE_TX_HASH });

  // Email & audit no-ops
  enqueueEmail.mockResolvedValue(undefined);
  audit.log = jest.fn();

  // Cache: no existing idempotency entries
  const cache = require('../utils/cache');
  cache.get.mockResolvedValue(null);
  cache.set.mockResolvedValue(undefined);
  cache.del.mockResolvedValue(undefined);

  // Session: token not blacklisted
  isJtiBlacklisted.mockResolvedValue(false);
});

// ===========================================================================
// Route file loadability
// ===========================================================================
describe('route file loadability', () => {
  test('both route files can be required without throwing', () => {
    jest.resetModules();
    expect(() => require('../routes/agentEscrow')).not.toThrow();
    expect(() => require('../routes/contracts')).not.toThrow();
  });
});

// ===========================================================================
// GET /api/escrow — listEscrows
// ===========================================================================
describe('GET /api/escrow', () => {
  test('returns 200 with paginated escrows for the caller (sender role)', async () => {
    setupDb({
      'SELECT public_key FROM wallets WHERE user_id': { rows: [{ public_key: SENDER_WALLET }] },
      'SELECT COUNT(*)': { rows: [{ total: 1 }] },
      'FROM agent_escrows': { rows: [escrowRow()] },
    });

    const res = await request(app)
      .get('/api/escrow?role=sender')
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.escrows).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
  });

  test('returns 200 with empty list when user has no wallets', async () => {
    setupDb({
      'SELECT public_key FROM wallets WHERE user_id': { rows: [] },
    });

    const res = await request(app)
      .get('/api/escrow')
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.escrows).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('returns 401 without Authorization header', async () => {
    const res = await request(app).get('/api/escrow');
    expect(res.status).toBe(401);
  });

  test('returns 400 for invalid status filter', async () => {
    setupDb({
      'SELECT public_key FROM wallets WHERE user_id': { rows: [{ public_key: SENDER_WALLET }] },
    });

    const res = await request(app)
      .get('/api/escrow?status=invalid')
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid status filter');
  });
});

// ===========================================================================
// GET /api/escrow/:id — getEscrow (IDOR protection)
// ===========================================================================
describe('GET /api/escrow/:id', () => {
  test('returns 200 when caller is the sender', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
      'SELECT public_key FROM wallets WHERE user_id': { rows: [{ public_key: SENDER_WALLET }] },
    });

    const res = await request(app)
      .get(`/api/escrow/${ESCROW_ID}`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.escrow).toBeDefined();
    expect(res.body.escrow.id).toBe(ESCROW_ID);
  });

  test('returns 200 when caller is the assigned agent', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
      'SELECT public_key FROM wallets WHERE user_id': { rows: [{ public_key: AGENT_WALLET }] },
    });

    const res = await request(app)
      .get(`/api/escrow/${ESCROW_ID}`)
      .set('Authorization', `Bearer ${makeToken(AGENT_ID, 'agent')}`);

    expect(res.status).toBe(200);
    expect(res.body.escrow.agent_wallet).toBe(AGENT_WALLET);
  });

  test('returns 200 when caller is the recipient', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
      'SELECT public_key FROM wallets WHERE user_id': { rows: [{ public_key: RECIPIENT_WALLET }] },
    });

    const res = await request(app)
      .get(`/api/escrow/${ESCROW_ID}`)
      .set('Authorization', `Bearer ${makeToken(OTHER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.escrow.recipient_wallet).toBe(RECIPIENT_WALLET);
  });

  test('returns 404 when escrow does not exist', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [] },
    });

    const res = await request(app)
      .get(`/api/escrow/${ESCROW_ID}`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Escrow not found');
  });

  test('returns 404 for an escrow the caller is not party to (IDOR)', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
      'SELECT public_key FROM wallets WHERE user_id': { rows: [{ public_key: OTHER_WALLET }] },
    });

    const res = await request(app)
      .get(`/api/escrow/${ESCROW_ID}`)
      .set('Authorization', `Bearer ${makeToken(OTHER_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Escrow not found');
  });

  test('returns 400 for invalid (non-UUID) id', async () => {
    const res = await request(app)
      .get('/api/escrow/not-a-uuid')
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /api/escrow/create
// ===========================================================================
describe('POST /api/escrow/create', () => {
  const validBody = {
    agent_wallet: VALID_AGENT_WALLET,
    recipient_wallet: VALID_RECIPIENT,
    amount: '50.0000000',
    asset: 'USDC',
  };

  test('returns 201 and creates escrow on valid request', async () => {
    setupDb({
      'SELECT id FROM agents WHERE': { rows: [{ id: 'agent-1' }] },
      'SELECT public_key, encrypted_secret_key FROM wallets': {
        rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: ENC_SECRET }],
      },
      'INSERT INTO agent_escrows': { rows: [] },
    });

    const res = await request(app)
      .post('/api/escrow/create')
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Escrow created');
    expect(res.body.escrow.status).toBe('pending');
    expect(createEscrow).toHaveBeenCalledTimes(1);
    // Verify stroops conversion: 50.0000000 → 500000000
    expect(createEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: '500000000',
        feeBps: 250,
      })
    );
  });

  test('returns 400 for unsupported asset', async () => {
    const res = await request(app)
      .post('/api/escrow/create')
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`)
      .send({ ...validBody, asset: 'XLM' });

    // express-validator rejects XLM (only USDC allowed)
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid amount (non-decimal string)', async () => {
    const res = await request(app)
      .post('/api/escrow/create')
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`)
      .send({ ...validBody, amount: 'abc' });

    // express-validator catches this
    expect(res.status).toBe(400);
  });

  test('returns 400 when agent is not registered', async () => {
    setupDb({
      'SELECT id FROM agents WHERE': { rows: [] },
    });

    const res = await request(app)
      .post('/api/escrow/create')
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`)
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Agent is not registered in the AfriPay network');
  });

  test('returns 404 when sender has no wallet', async () => {
    setupDb({
      'SELECT id FROM agents WHERE': { rows: [{ id: 'agent-1' }] },
      'SELECT public_key, encrypted_secret_key FROM wallets': { rows: [] },
    });

    const res = await request(app)
      .post('/api/escrow/create')
      .set('Authorization', `Bearer ${makeToken(SENDER_ID)}`)
      .send(validBody);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Wallet not found');
  });

  test('returns 401 without Authorization header', async () => {
    const res = await request(app).post('/api/escrow/create').send(validBody);
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// POST /api/escrow/:id/confirm (and /confirm-payout alias)
// ===========================================================================
describe('POST /api/escrow/:id/confirm', () => {
  test('returns 200 when agent confirms payout', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
      'SELECT public_key FROM wallets WHERE user_id': {
        rows: [{ public_key: AGENT_WALLET }],
      },
      'SELECT encrypted_secret_key FROM wallets WHERE public_key': {
        rows: [{ encrypted_secret_key: ENC_SECRET }],
      },
      'UPDATE agent_escrows SET status': { rows: [] },
      'SELECT u.email': { rows: [{ email: 's@e.com', full_name: 'Sender' }] },
    });

    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/confirm`)
      .set('Authorization', `Bearer ${makeToken(AGENT_ID, 'agent')}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Payout confirmed');
    expect(confirmPayout).toHaveBeenCalledTimes(1);
  });

  test('returns 403 when non-agent user tries to confirm', async () => {
    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/confirm`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID, 'user')}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only agents can confirm payouts');
  });

  test('returns 404 when escrow does not exist', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [] },
    });

    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/confirm`)
      .set('Authorization', `Bearer ${makeToken(AGENT_ID, 'agent')}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Escrow not found');
  });

  test('returns 400 when escrow is not pending', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow({ status: 'completed' })] },
    });

    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/confirm`)
      .set('Authorization', `Bearer ${makeToken(AGENT_ID, 'agent')}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Escrow is not pending');
  });

  test('returns 403 when caller is not the assigned agent', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
      'SELECT public_key FROM wallets WHERE user_id': {
        rows: [{ public_key: SENDER_WALLET }], // different from AGENT_WALLET
      },
    });

    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/confirm`)
      .set('Authorization', `Bearer ${makeToken(AGENT_ID, 'agent')}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You are not the assigned agent for this escrow');
  });

  test('confirm-payout alias route also works', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
      'SELECT public_key FROM wallets WHERE user_id': {
        rows: [{ public_key: AGENT_WALLET }],
      },
      'SELECT encrypted_secret_key FROM wallets WHERE public_key': {
        rows: [{ encrypted_secret_key: ENC_SECRET }],
      },
      'UPDATE agent_escrows SET status': { rows: [] },
      'SELECT u.email': { rows: [{ email: 's@e.com', full_name: 'Sender' }] },
    });

    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/confirm-payout`)
      .set('Authorization', `Bearer ${makeToken(AGENT_ID, 'agent')}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Payout confirmed');
  });
});

// ===========================================================================
// POST /api/escrow/:id/cancel
// ===========================================================================
describe('POST /api/escrow/:id/cancel', () => {
  test('returns 200 when sender cancels their escrow', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
      'SELECT encrypted_secret_key FROM wallets WHERE user_id': {
        rows: [{ encrypted_secret_key: ENC_SECRET }],
      },
      'UPDATE agent_escrows SET status': { rows: [] },
    });

    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/cancel`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID, 'user', SENDER_WALLET)}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Escrow cancelled, funds refunded');
    expect(cancelEscrow).toHaveBeenCalledTimes(1);
  });

  test('returns 404 when escrow does not exist', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [] },
    });

    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/cancel`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID, 'user', SENDER_WALLET)}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Escrow not found');
  });

  test('returns 400 when escrow is not pending', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow({ status: 'completed' })] },
    });

    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/cancel`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID, 'user', SENDER_WALLET)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Escrow is not pending');
  });

  test('returns 403 when caller is not the sender', async () => {
    setupDb({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
    });

    const res = await request(app)
      .post(`/api/escrow/${ESCROW_ID}/cancel`)
      .set('Authorization', `Bearer ${makeToken(OTHER_ID, 'user', OTHER_WALLET)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only the sender can cancel this escrow');
  });
});

// ===========================================================================
// POST /api/contracts/escrow/:id/partial-release
// ===========================================================================
describe('POST /api/contracts/escrow/:id/partial-release', () => {
  /**
   * Helper: set up db.pool.connect() with a mock client whose queries
   * return based on the SQL string.
   */
  function setupPoolClient(queries) {
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
        if (sql === 'COMMIT') return Promise.resolve({ rows: [] });
        if (sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
        for (const [pattern, value] of Object.entries(queries)) {
          if (typeof sql === 'string' && sql.includes(pattern)) {
            return Promise.resolve(value);
          }
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    db.pool = { connect: jest.fn().mockResolvedValue(mockClient) };
    return mockClient;
  }

  test('returns 200 with updated balances on valid partial release', async () => {
    setupDb(); // auth check only
    const mockClient = setupPoolClient({
      'SELECT * FROM agent_escrows WHERE id': {
        rows: [escrowRow({ amount: '100', released_amount: 0 })],
      },
      'UPDATE agent_escrows SET released_amount': { rows: [] },
    });

    const res = await request(app)
      .post(`/api/contracts/escrow/${ESCROW_ID}/partial-release`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID, 'user', SENDER_WALLET)}`)
      .send({ amount: 30 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Partial release recorded');
    expect(res.body.released_amount).toBe(30);
    expect(res.body.remaining).toBe(70);
    expect(res.body.fee).toBe(0.75); // 30 * 250 / 10000
    expect(res.body.net_amount).toBe(29.25);
    expect(mockClient.release).toHaveBeenCalled();
  });

  test('returns 404 when escrow does not exist', async () => {
    setupDb();
    const mockClient = setupPoolClient({
      'SELECT * FROM agent_escrows WHERE id': { rows: [] },
    });

    const res = await request(app)
      .post(`/api/contracts/escrow/${ESCROW_ID}/partial-release`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID, 'user', SENDER_WALLET)}`)
      .send({ amount: 30 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Escrow not found');
  });

  test('returns 400 when amount exceeds remaining balance', async () => {
    setupDb();
    setupPoolClient({
      'SELECT * FROM agent_escrows WHERE id': {
        rows: [escrowRow({ amount: '100', released_amount: 80 })],
      },
    });

    const res = await request(app)
      .post(`/api/contracts/escrow/${ESCROW_ID}/partial-release`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID, 'user', SENDER_WALLET)}`)
      .send({ amount: 50 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Amount exceeds remaining escrow balance');
  });

  test('returns 403 when caller is not the sender', async () => {
    setupDb();
    setupPoolClient({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow()] },
    });

    const res = await request(app)
      .post(`/api/contracts/escrow/${ESCROW_ID}/partial-release`)
      .set('Authorization', `Bearer ${makeToken(OTHER_ID, 'user', OTHER_WALLET)}`)
      .send({ amount: 30 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only the sender can release funds');
  });

  test('returns 400 when amount is not positive', async () => {
    setupDb();

    const res = await request(app)
      .post(`/api/contracts/escrow/${ESCROW_ID}/partial-release`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID, 'user', SENDER_WALLET)}`)
      .send({ amount: 0 });

    // express-validator catches amount <= 0
    expect(res.status).toBe(400);
  });

  test('returns 400 when escrow is not pending', async () => {
    setupDb();
    setupPoolClient({
      'SELECT * FROM agent_escrows WHERE id': { rows: [escrowRow({ status: 'completed' })] },
    });

    const res = await request(app)
      .post(`/api/contracts/escrow/${ESCROW_ID}/partial-release`)
      .set('Authorization', `Bearer ${makeToken(SENDER_ID, 'user', SENDER_WALLET)}`)
      .send({ amount: 30 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Escrow is not pending');
  });
});
