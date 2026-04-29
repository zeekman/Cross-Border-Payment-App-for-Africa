const request = require('supertest');
const express = require('express');

jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-123' };
  next();
});

const db = require('../db');
const analyticsRouter = require('../routes/analytics');

const app = express();
app.use(express.json());
app.use('/analytics', analyticsRouter);

const WALLET = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

const emptyRows = { rows: [] };

function mockWalletAndQueries() {
  db.query
    .mockResolvedValueOnce({ rows: [{ public_key: WALLET }] }) // wallet lookup
    .mockResolvedValueOnce(emptyRows) // monthly
    .mockResolvedValueOnce(emptyRows) // top_recipients
    .mockResolvedValueOnce(emptyRows) // asset_breakdown
    .mockResolvedValueOnce(emptyRows); // frequency
}

beforeEach(() => jest.clearAllMocks());

describe('GET /analytics/summary', () => {
  test('returns 200 with period defaulting to last 30 days', async () => {
    mockWalletAndQueries();

    const res = await request(app)
      .get('/analytics/summary')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('period');
    expect(res.body).toHaveProperty('monthly');
    expect(res.body).toHaveProperty('top_recipients');
    expect(res.body).toHaveProperty('asset_breakdown');
    expect(res.body).toHaveProperty('transaction_frequency');

    const from = new Date(res.body.period.from);
    const to = new Date(res.body.period.to);
    const diffDays = (to - from) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(30, 0);
  });

  test('accepts explicit from/to date params', async () => {
    mockWalletAndQueries();

    const res = await request(app)
      .get('/analytics/summary?from=2024-01-01&to=2024-01-31')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.period.from).toMatch(/^2024-01-01/);
    expect(res.body.period.to).toMatch(/^2024-01-31/);
  });

  test('returns 400 for invalid date format', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ public_key: WALLET }] });

    const res = await request(app)
      .get('/analytics/summary?from=not-a-date')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid date/i);
  });

  test('returns 400 when from is after to', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ public_key: WALLET }] });

    const res = await request(app)
      .get('/analytics/summary?from=2024-06-01&to=2024-01-01')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from must be before/i);
  });

  test('returns 404 when wallet not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/analytics/summary')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Wallet not found');
  });

  test('queries use sender_wallet/recipient_wallet (indexed columns), not user_id', async () => {
    mockWalletAndQueries();

    await request(app)
      .get('/analytics/summary')
      .set('Authorization', 'Bearer token');

    // First call is the wallet lookup
    expect(db.query.mock.calls[0][0]).toMatch(/wallets WHERE user_id/);
    // Subsequent calls must reference sender_wallet or recipient_wallet, never user_id
    for (let i = 1; i < db.query.mock.calls.length; i++) {
      const sql = db.query.mock.calls[i][0];
      expect(sql).toMatch(/sender_wallet|recipient_wallet/);
      expect(sql).not.toMatch(/user_id/);
    }
  });
});
