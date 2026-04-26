process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.STELLAR_NETWORK = 'testnet';
process.env.JWT_SECRET = 'test_secret';
process.env.FRONTEND_URL = 'http://localhost:3000';

jest.mock('../src/db');

const request = require('supertest');
const db = require('../src/db');
const stellar = require('../src/services/stellar');
const app = require('../src/app');

/** Default pool stats returned by the mock unless overridden per-test. */
const DEFAULT_POOL_STATS = { total: 5, idle: 3, waiting: 0 };

describe('GET /health', () => {
  let horizonSpy;

  beforeAll(() => {
    horizonSpy = jest.spyOn(stellar, 'checkHorizonHealth');
  });

  afterAll(() => {
    horizonSpy.mockRestore();
  });

  beforeEach(() => {
    db.query.mockImplementation((sql) => {
      if (String(sql).includes('SELECT 1')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      return Promise.resolve({ rows: [] });
    });
    db.getPoolStats.mockReturnValue(DEFAULT_POOL_STATS);
    horizonSpy.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns 200 with ok status when database and Horizon are reachable', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      db: 'ok',
      stellar: 'ok',
      network: 'testnet',
    });
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
    expect(horizonSpy).toHaveBeenCalled();
    expect(res.body).not.toHaveProperty('error');
  });

  test('returns 503 when database is down', async () => {
    db.query.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'degraded',
      db: 'down',
      stellar: 'ok',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/refused/i);
  });

  test('returns 503 when Stellar Horizon check fails', async () => {
    horizonSpy.mockResolvedValueOnce(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'degraded',
      db: 'ok',
      stellar: 'down',
    });
  });

  test('returns 503 when both dependencies fail', async () => {
    db.query.mockRejectedValueOnce(new Error('econnrefused'));
    horizonSpy.mockResolvedValueOnce(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.db).toBe('down');
    expect(res.body.stellar).toBe('down');
    expect(res.body.status).toBe('degraded');
  });

  // ─── Pool stats tests ───────────────────────────────────────────────────────

  test('includes pool stats in a healthy response', async () => {
    db.getPoolStats.mockReturnValueOnce({ total: 10, idle: 8, waiting: 0 });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pool');
    expect(res.body.pool).toEqual({ total: 10, idle: 8, waiting: 0 });
  });

  test('includes pool stats even when db is down', async () => {
    db.query.mockRejectedValueOnce(new Error('connection refused'));
    db.getPoolStats.mockReturnValueOnce({ total: 20, idle: 0, waiting: 8 });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty('pool');
    expect(res.body.pool).toMatchObject({ total: 20, idle: 0, waiting: 8 });
  });

  test('pool stats have the correct numeric fields', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    const { pool } = res.body;
    expect(typeof pool.total).toBe('number');
    expect(typeof pool.idle).toBe('number');
    expect(typeof pool.waiting).toBe('number');
  });

  test('pool stats reflect the default mock values when not overridden', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.pool).toEqual(DEFAULT_POOL_STATS);
  });
});
