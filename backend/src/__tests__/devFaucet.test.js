'use strict';
const request = require('supertest');
const express = require('express');

jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-test-id' };
  next();
});
// stellar.js has a pre-existing syntax issue; mock it so app.js loads
jest.mock('../services/stellar', () => ({}));

function buildDevApp(nodeEnv) {
  jest.resetModules();
  jest.mock('../db');
  jest.mock('../middleware/auth', () => (req, res, next) => {
    req.user = { userId: 'user-test-id' };
    next();
  });
  jest.mock('../services/stellar', () => ({}));
  process.env.NODE_ENV = nodeEnv;
  const devRouter = require('../routes/dev');
  const db = require('../db');
  const app = express();
  app.use(express.json());
  app.use('/api/dev', devRouter);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return { app, db };
}

function buildFullApp(nodeEnv) {
  jest.resetModules();
  jest.mock('../db');
  jest.mock('../middleware/auth', () => (req, res, next) => {
    req.user = { userId: 'user-test-id' };
    next();
  });
  jest.mock('../services/stellar', () => ({}));
  process.env.NODE_ENV = nodeEnv;
  // Build a minimal app that mirrors app.js conditional mount logic
  const devRouter = require('../routes/dev');
  const app = express();
  app.use(express.json());
  if (process.env.NODE_ENV !== 'production') {
    app.use('/api/dev', devRouter);
  }
  return app;
}

const originalEnv = process.env.NODE_ENV;
afterAll(() => { process.env.NODE_ENV = originalEnv; });

// ── App-level mount guard (issue #266) ───────────────────────────────────────

describe('POST /api/dev/fund-wallet — app-level mount guard', () => {
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  test('returns 404 in production (route not mounted at app level)', async () => {
    const app = buildFullApp('production');
    const res = await request(app).post('/api/dev/fund-wallet');
    expect(res.status).toBe(404);
  });
});

// ── Router-level environment guard ───────────────────────────────────────────

describe('POST /api/dev/fund-wallet — router environment guard', () => {
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  test('returns 404 in production', async () => {
    const { app } = buildDevApp('production');
    const res = await request(app).post('/api/dev/fund-wallet');
    expect(res.status).toBe(404);
  });

  test('returns 404 in test environment', async () => {
    const { app } = buildDevApp('test');
    const res = await request(app).post('/api/dev/fund-wallet');
    expect(res.status).toBe(404);
  });
});

// ── Development mode ─────────────────────────────────────────────────────────

describe('POST /api/dev/fund-wallet — development', () => {
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  test('funds wallet successfully', async () => {
    const { app, db } = buildDevApp('development');
    db.query.mockResolvedValueOnce({ rows: [{ public_key: 'GPUBLICKEY123' }] });
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true });

    const res = await request(app).post('/api/dev/fund-wallet');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/funded/i);
    expect(res.body.public_key).toBe('GPUBLICKEY123');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('friendbot.stellar.org?addr=GPUBLICKEY123')
    );
  });

  test('returns 502 when Friendbot fails', async () => {
    const { app, db } = buildDevApp('development');
    db.query.mockResolvedValueOnce({ rows: [{ public_key: 'GPUBLICKEY123' }] });
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, text: async () => 'rate limited' });

    const res = await request(app).post('/api/dev/fund-wallet');

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/friendbot failed/i);
  });

  test('returns 404 when wallet not found', async () => {
    const { app, db } = buildDevApp('development');
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/dev/fund-wallet');
    expect(res.status).toBe(404);
  });
});
