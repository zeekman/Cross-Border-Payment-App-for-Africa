'use strict';
/**
 * Tests for GET /api/wallet/transactions deprecation (issue #270)
 *
 * Verifies that the endpoint:
 *  - Still returns data (backward-compatible)
 *  - Sets Deprecation: true header
 *  - Sets Link header pointing to /api/payments/history
 */

jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-test-id' };
  next();
});
jest.mock('../services/stellar', () => ({}));

const request = require('supertest');
const express = require('express');
const db = require('../db');

// Build a minimal app with just the wallet router
function buildApp() {
  jest.resetModules();
  jest.mock('../db');
  jest.mock('../middleware/auth', () => (req, res, next) => {
    req.user = { userId: 'user-test-id' };
    next();
  });
  jest.mock('../services/stellar', () => ({}));
  const walletRouter = require('../routes/wallet');
  const app = express();
  app.use(express.json());
  app.use('/api/wallet', walletRouter);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return { app, db: require('../db') };
}

describe('GET /api/wallet/transactions — deprecation', () => {
  test('responds with Deprecation: true header', async () => {
    const { app, db } = buildApp();
    // resolveWallet queries wallets table
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: 'GPUBKEY', id: 'w-1', encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [] }); // transactions query

    const res = await request(app)
      .get('/api/wallet/transactions')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.headers['deprecation']).toBe('true');
  });

  test('Link header points to /api/payments/history', async () => {
    const { app, db } = buildApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: 'GPUBKEY', id: 'w-1', encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/wallet/transactions')
      .set('Authorization', 'Bearer token');

    expect(res.headers['link']).toMatch(/\/api\/payments\/history/);
    expect(res.headers['link']).toMatch(/successor-version/);
  });

  test('still returns transactions array (backward-compatible)', async () => {
    const { app, db } = buildApp();
    const fakeTx = { id: 'tx-1', amount: '10', asset: 'XLM' };
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: 'GPUBKEY', id: 'w-1', encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [fakeTx] });

    const res = await request(app)
      .get('/api/wallet/transactions')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([fakeTx]);
  });
});
