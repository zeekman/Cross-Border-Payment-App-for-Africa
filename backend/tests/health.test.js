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
    horizonSpy.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns 200 with ok status when database and Horizon are reachable', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
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
});
