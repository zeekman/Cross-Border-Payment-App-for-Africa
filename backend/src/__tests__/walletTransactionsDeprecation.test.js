'use strict';
/**
 * Tests for GET /api/wallet/transactions removal (issue #270, BE-175)
 *
 * Verifies that the endpoint:
 *  - Responds 410 Gone without querying transactions
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

describe('GET /api/wallet/transactions — removed', () => {
  test('responds 410 Gone without touching the database', async () => {
    const { app, db } = buildApp();

    const res = await request(app)
      .get('/api/wallet/transactions')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(410);
    expect(res.body.successor).toBe('/api/payments/history');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('Link header points to /api/payments/history', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/wallet/transactions')
      .set('Authorization', 'Bearer token');

    expect(res.headers['link']).toMatch(/\/api\/payments\/history/);
    expect(res.headers['link']).toMatch(/successor-version/);
  });
});
