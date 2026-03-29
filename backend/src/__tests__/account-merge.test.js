/**
 * Tests for the account merge flow:
 *   - stellar.mergeAccount (service layer)
 *   - POST /api/wallet/merge (controller + route)
 */

// ---------------------------------------------------------------------------
// Shared mock Horizon server
// ---------------------------------------------------------------------------
const mockServer = {
  loadAccount: jest.fn(),
  fetchBaseFee: jest.fn().mockResolvedValue(100),
  submitTransaction: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: { Server: jest.fn().mockImplementation(() => mockServer) },
  };
});

global.fetch = jest.fn().mockResolvedValue({ ok: true });

const stellar = require('../services/stellar');
const StellarSdk = require('@stellar/stellar-sdk');

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!!!';

function setEnv() {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.STELLAR_NETWORK = 'testnet';
}

function mockAccount(publicKey) {
  return {
    id: publicKey,
    balances: [{ asset_type: 'native', balance: '50.0000000' }],
    incrementSequenceNumber: jest.fn(),
    sequenceNumber: jest.fn().mockReturnValue('1'),
    accountId: jest.fn().mockReturnValue(publicKey),
  };
}

// ---------------------------------------------------------------------------
// stellar.mergeAccount unit tests
// ---------------------------------------------------------------------------
describe('stellar.mergeAccount', () => {
  beforeAll(setEnv);
  beforeEach(() => jest.clearAllMocks());

  it('builds and submits an accountMerge transaction', async () => {
    const sourceKeypair = StellarSdk.Keypair.random();
    const destKeypair = StellarSdk.Keypair.random();

    const { encryptPrivateKey } = stellar;
    const encryptedSecret = encryptPrivateKey(sourceKeypair.secret());

    mockServer.loadAccount.mockResolvedValue(mockAccount(sourceKeypair.publicKey()));
    mockServer.submitTransaction.mockResolvedValue({ hash: 'merge_hash_abc', ledger: 42 });

    const result = await stellar.mergeAccount({
      sourcePublicKey: sourceKeypair.publicKey(),
      encryptedSecretKey: encryptedSecret,
      destinationPublicKey: destKeypair.publicKey(),
    });

    expect(result.transactionHash).toBe('merge_hash_abc');
    expect(result.ledger).toBe(42);
    expect(mockServer.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it('throws when Horizon rejects the transaction', async () => {
    const sourceKeypair = StellarSdk.Keypair.random();
    const destKeypair = StellarSdk.Keypair.random();
    const { encryptPrivateKey } = stellar;
    const encryptedSecret = encryptPrivateKey(sourceKeypair.secret());

    mockServer.loadAccount.mockResolvedValue(mockAccount(sourceKeypair.publicKey()));
    mockServer.submitTransaction.mockRejectedValue(new Error('tx_failed'));

    await expect(
      stellar.mergeAccount({
        sourcePublicKey: sourceKeypair.publicKey(),
        encryptedSecretKey: encryptedSecret,
        destinationPublicKey: destKeypair.publicKey(),
      })
    ).rejects.toThrow('tx_failed');
  });
});

// ---------------------------------------------------------------------------
// POST /api/wallet/merge controller tests
// ---------------------------------------------------------------------------
jest.mock('../db');
jest.mock('../services/stellar');
jest.mock('../services/audit');

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const stellarMock = require('../services/stellar');
const audit = require('../services/audit');

process.env.JWT_SECRET = 'test_jwt_secret';

function buildApp() {
  const app = express();
  app.use(express.json());
  const walletRoutes = require('../routes/wallet');
  app.use('/api/wallet', walletRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function makeToken(userId = 1) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

describe('POST /api/wallet/merge', () => {
  let app;
  const destKeypair = StellarSdk.Keypair.random();

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when destination is missing', async () => {
    const res = await request(app)
      .post('/api/wallet/merge')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ password: 'secret' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/wallet/merge')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ destination: destKeypair.publicKey() });
    expect(res.status).toBe(400);
  });

  it('returns 401 when password is wrong', async () => {
    const hash = await bcrypt.hash('correct_password', 1);
    db.query
      .mockResolvedValueOnce({ rows: [{ password_hash: hash }] }) // user lookup
      .mockResolvedValueOnce({ rows: [{ public_key: 'GPUB', encrypted_secret_key: 'enc' }] }); // wallet

    const res = await request(app)
      .post('/api/wallet/merge')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ destination: destKeypair.publicKey(), password: 'wrong_password' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect password/i);
  });

  it('merges account and deletes wallet record on success', async () => {
    const hash = await bcrypt.hash('correct_password', 1);
    const srcKeypair = StellarSdk.Keypair.random();

    db.query
      .mockResolvedValueOnce({ rows: [{ password_hash: hash }] })
      .mockResolvedValueOnce({ rows: [{ public_key: srcKeypair.publicKey(), encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [] }); // DELETE

    stellarMock.mergeAccount.mockResolvedValue({ transactionHash: 'hash_xyz', ledger: 10 });
    audit.log = jest.fn();

    const res = await request(app)
      .post('/api/wallet/merge')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ destination: destKeypair.publicKey(), password: 'correct_password' });

    expect(res.status).toBe(200);
    expect(res.body.transaction_hash).toBe('hash_xyz');
    expect(stellarMock.mergeAccount).toHaveBeenCalledTimes(1);
    // Verify wallet deletion was called
    const deleteCalls = db.query.mock.calls.filter(c => /DELETE/i.test(c[0]));
    expect(deleteCalls.length).toBeGreaterThan(0);
  });
});
