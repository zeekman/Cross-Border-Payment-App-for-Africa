/**
 * Integration tests for the loyalty rewards API
 *
 * Routes tested:
 *   GET  /api/loyalty/balance   — on-chain point balance
 *   POST /api/loyalty/redeem    — redeem 100 points for a 50 % fee discount
 *   GET  /api/loyalty/history   — off-chain mint/burn ledger
 *
 * Both the database and Soroban service are fully mocked.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('../db');
jest.mock('../services/loyaltyToken', () => ({
  mintPoints:   jest.fn(),
  redeemPoints: jest.fn(),
  getBalance:   jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { redeemPoints, getBalance } = require('../services/loyaltyToken');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
process.env.JWT_SECRET      = 'test-jwt-secret';
process.env.ENCRYPTION_KEY  = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK = 'testnet';

const loyaltyRouter = require('../routes/loyalty');

const app = express();
app.use(express.json());
app.use('/api/loyalty', loyaltyRouter);
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const JWT_SECRET   = 'test-jwt-secret';
const USER_ID      = uuidv4();
const WALLET       = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const ENC_SECRET   = 'deadbeef:deadbeef01234567deadbeef01234567deadbeef01234567';
const FAKE_TX_HASH = 'a'.repeat(64);

const WALLET_ROW = { public_key: WALLET, encrypted_secret_key: ENC_SECRET };

function makeToken(userId = USER_ID) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.resetAllMocks();
  getBalance.mockResolvedValue(150);
  redeemPoints.mockResolvedValue({ redeemed: true, txHash: FAKE_TX_HASH });
  db.query.mockResolvedValue({ rows: [] });
});

// ===========================================================================
// GET /api/loyalty/balance
// ===========================================================================
describe('GET /api/loyalty/balance — authentication', () => {
  test('returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/api/loyalty/balance');
    expect(res.status).toBe(401);
    expect(getBalance).not.toHaveBeenCalled();
  });

  test('returns 401 for a malformed token', async () => {
    const res = await request(app)
      .get('/api/loyalty/balance')
      .set('Authorization', 'Bearer not.a.valid.jwt');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/loyalty/balance — success', () => {
  test('returns 200 with wallet and points', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ public_key: WALLET }] });

    const res = await request(app)
      .get('/api/loyalty/balance')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(WALLET);
    expect(res.body.points).toBe(150);
    expect(getBalance).toHaveBeenCalledWith({ walletAddress: WALLET });
  });

  test('returns 404 when wallet is not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/loyalty/balance')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
    expect(getBalance).not.toHaveBeenCalled();
  });

  test('returns 0 points when contract returns 0', async () => {
    getBalance.mockResolvedValueOnce(0);
    db.query.mockResolvedValueOnce({ rows: [{ public_key: WALLET }] });

    const res = await request(app)
      .get('/api/loyalty/balance')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.points).toBe(0);
  });
});

// ===========================================================================
// POST /api/loyalty/redeem
// ===========================================================================
describe('POST /api/loyalty/redeem — authentication', () => {
  test('returns 401 with no Authorization header', async () => {
    const res = await request(app).post('/api/loyalty/redeem');
    expect(res.status).toBe(401);
    expect(redeemPoints).not.toHaveBeenCalled();
  });
});

describe('POST /api/loyalty/redeem — success', () => {
  test('returns 200 with discount info when redemption succeeds', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })  // wallet lookup
      .mockResolvedValueOnce({ rows: [] });            // INSERT loyalty_points

    const res = await request(app)
      .post('/api/loyalty/redeem')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.redeemed).toBe(true);
    expect(res.body.discount_pct).toBe(50);
    expect(res.body.tx_hash).toBe(FAKE_TX_HASH);
    expect(res.body.message).toMatch(/50 %/);
  });

  test('calls redeemPoints with correct wallet and encrypted key', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/api/loyalty/redeem')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(redeemPoints).toHaveBeenCalledWith({
      encryptedSecretKey: ENC_SECRET,
      walletAddress:      WALLET,
    });
  });

  test('records burn event in loyalty_points table', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/api/loyalty/redeem')
      .set('Authorization', `Bearer ${makeToken()}`);

    const insertCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO loyalty_points') && sql.includes('burn')
    );
    expect(insertCall).toBeDefined();
    const params = insertCall[1];
    expect(params[2]).toBe(WALLET);   // wallet_address
    expect(params[3]).toBe(100);      // points burned
    expect(params[4]).toBe(FAKE_TX_HASH);
  });
});

describe('POST /api/loyalty/redeem — insufficient points', () => {
  test('returns 400 when user has fewer than 100 points', async () => {
    redeemPoints.mockResolvedValueOnce({ redeemed: false, txHash: null });
    db.query.mockResolvedValueOnce({ rows: [WALLET_ROW] });

    const res = await request(app)
      .post('/api/loyalty/redeem')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.redeemed).toBe(false);
    expect(res.body.error).toMatch(/100 points/);
  });

  test('does not insert a burn record when redemption fails', async () => {
    redeemPoints.mockResolvedValueOnce({ redeemed: false, txHash: null });
    db.query.mockResolvedValueOnce({ rows: [WALLET_ROW] });

    await request(app)
      .post('/api/loyalty/redeem')
      .set('Authorization', `Bearer ${makeToken()}`);

    const insertCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO loyalty_points')
    );
    expect(insertCall).toBeUndefined();
  });

  test('returns 404 when wallet is not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/loyalty/redeem')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
    expect(redeemPoints).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GET /api/loyalty/history
// ===========================================================================
describe('GET /api/loyalty/history — authentication', () => {
  test('returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/api/loyalty/history');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/loyalty/history — success', () => {
  const MINT_ROW = {
    id:             uuidv4(),
    event_type:     'mint',
    points:         50,
    transaction_id: uuidv4(),
    tx_hash:        FAKE_TX_HASH,
    created_at:     new Date().toISOString(),
  };

  const BURN_ROW = {
    id:             uuidv4(),
    event_type:     'burn',
    points:         100,
    transaction_id: null,
    tx_hash:        FAKE_TX_HASH,
    created_at:     new Date().toISOString(),
  };

  test('returns 200 with empty history when no events exist', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/loyalty/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.history).toEqual([]);
  });

  test('returns mint and burn events in order', async () => {
    db.query.mockResolvedValueOnce({ rows: [MINT_ROW, BURN_ROW] });

    const res = await request(app)
      .get('/api/loyalty/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(2);
    expect(res.body.history[0].event_type).toBe('mint');
    expect(res.body.history[1].event_type).toBe('burn');
  });

  test('queries history by user_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/loyalty/history')
      .set('Authorization', `Bearer ${makeToken()}`);

    const historyQuery = db.query.mock.calls.find(([sql]) =>
      sql.includes('loyalty_points') && sql.includes('user_id')
    );
    expect(historyQuery).toBeDefined();
    expect(historyQuery[1][0]).toBe(USER_ID);
  });
});

// ===========================================================================
// mintPoints integration — payment controller fires-and-forgets
// ===========================================================================
describe('mintPoints — fire-and-forget after payment', () => {
  test('mintPoints is exported from loyaltyToken service', () => {
    const { mintPoints } = require('../services/loyaltyToken');
    expect(typeof mintPoints).toBe('function');
  });

  test('paymentController imports mintPoints', () => {
    // Verify the import exists without executing the full controller
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../controllers/paymentController.js'),
      'utf8'
    );
    expect(src).toContain("require('../services/loyaltyToken')");
    expect(src).toContain('mintPoints');
  });
});
