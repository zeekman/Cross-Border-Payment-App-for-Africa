/**
 * Tests for multi-wallet support
 *
 * Covers:
 *  - POST /api/wallet/create  (happy path, label validation, 5-wallet limit)
 *  - GET  /api/wallet/list
 *  - GET  /api/wallet/balance  with ?wallet_id
 */

// ---------------------------------------------------------------------------
// Env must be set BEFORE requiring app modules
// ---------------------------------------------------------------------------
process.env.JWT_SECRET      = 'test-secret';
process.env.ENCRYPTION_KEY  = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK = 'testnet';

const request = require('supertest');
const app = require('../app');
const db = require('../db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal JWT-like token stub — the real auth middleware verifies with JWT_SECRET */
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'test-secret';

function makeToken(userId) {
  return jwt.sign({ userId }, TEST_SECRET, { expiresIn: '1h' });
}

// ---------------------------------------------------------------------------
// Mock heavy external dependencies so tests run without a live DB / Horizon
// ---------------------------------------------------------------------------

jest.mock('../db');
jest.mock('../services/stellar', () => ({
  createWallet: jest.fn(),
  getBalance: jest.fn(),
  getTransactions: jest.fn(),
  decryptPrivateKey: jest.fn(),
  addAccountSigner: jest.fn(),
  removeAccountSigner: jest.fn(),
  addTrustline: jest.fn(),
  removeTrustline: jest.fn(),
  getTrustlines: jest.fn(),
  mergeAccount: jest.fn(),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../utils/cache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  BALANCE_TTL: 30,
}));

const stellar = require('../services/stellar');

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TOKEN = makeToken(USER_ID);

const WALLET_1 = {
  id: 'bbbbbbbb-0000-0000-0000-000000000001',
  user_id: USER_ID,
  public_key: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  encrypted_secret_key: 'iv:enc',
  label: 'Main',
  is_default: true,
};

// ---------------------------------------------------------------------------
// POST /api/wallet/create
// ---------------------------------------------------------------------------

describe('POST /api/wallet/create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a new wallet with a custom label', async () => {
    // User currently has 1 wallet
    db.query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })          // COUNT check
      .mockResolvedValueOnce({ rows: [] });                         // INSERT

    stellar.createWallet.mockResolvedValue({
      publicKey: 'GBVVJJWBKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQ',
      encryptedSecretKey: 'iv2:enc2',
    });

    const res = await request(app)
      .post('/api/wallet/create')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ label: 'Savings' });

    expect(res.status).toBe(201);
    expect(res.body.wallet.label).toBe('Savings');
    expect(res.body.wallet.is_default).toBe(false);
    expect(stellar.createWallet).toHaveBeenCalledTimes(1);
  });

  it('uses default label "Wallet" when no label is provided', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [] });

    stellar.createWallet.mockResolvedValue({
      publicKey: 'GBVVJJWBKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQZFKQ',
      encryptedSecretKey: 'iv2:enc2',
    });

    const res = await request(app)
      .post('/api/wallet/create')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.wallet.label).toBe('Wallet');
  });

  it('rejects creation when user already has 5 wallets', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '5' }] }); // COUNT = 5

    const res = await request(app)
      .post('/api/wallet/create')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ label: 'Sixth' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WALLET_LIMIT_REACHED');
    expect(stellar.createWallet).not.toHaveBeenCalled();
  });

  it('rejects a label longer than 100 characters', async () => {
    const res = await request(app)
      .post('/api/wallet/create')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ label: 'x'.repeat(101) });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/wallet/create').send({ label: 'Test' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/wallet/list
// ---------------------------------------------------------------------------

describe('GET /api/wallet/list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns all wallets for the user with balances', async () => {
    const mockWallets = [
      { ...WALLET_1 },
      {
        id: 'cccccccc-0000-0000-0000-000000000002',
        user_id: USER_ID,
        public_key: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZXG5CPCJDGWESFIFKQZF',
        label: 'Savings',
        is_default: false,
        created_at: new Date().toISOString(),
      },
    ];

    db.query.mockResolvedValueOnce({ rows: mockWallets });
    stellar.getBalance
      .mockResolvedValueOnce([{ asset: 'XLM', balance: '100.0000000' }])
      .mockResolvedValueOnce([{ asset: 'XLM', balance: '50.0000000' }]);

    const res = await request(app)
      .get('/api/wallet/list')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.wallets).toHaveLength(2);
    expect(res.body.wallets[0].label).toBe('Main');
    expect(res.body.wallets[0].balances).toBeDefined();
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/wallet/list');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/wallet/balance  with ?wallet_id
// ---------------------------------------------------------------------------

describe('GET /api/wallet/balance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns balance for the specified wallet_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [WALLET_1] });
    stellar.getBalance.mockResolvedValue([{ asset: 'XLM', balance: '200.0000000' }]);

    const res = await request(app)
      .get(`/api/wallet/balance?wallet_id=${WALLET_1.id}`)
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(WALLET_1.id);
    expect(res.body.label).toBe('Main');
  });

  it('returns 404 when wallet_id does not belong to the user', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no matching wallet

    const res = await request(app)
      .get('/api/wallet/balance?wallet_id=00000000-dead-beef-0000-000000000000')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(404);
  });

  it('falls back to default wallet when no wallet_id is given', async () => {
    db.query.mockResolvedValueOnce({ rows: [WALLET_1] });
    stellar.getBalance.mockResolvedValue([{ asset: 'XLM', balance: '100.0000000' }]);

    const res = await request(app)
      .get('/api/wallet/balance')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.is_default).toBe(true);
  });
});
