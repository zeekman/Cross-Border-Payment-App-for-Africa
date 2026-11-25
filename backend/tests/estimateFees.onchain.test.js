/**
 * Integration tests for GET /api/payments/estimate-fees
 * Verifies all three fallback paths per issue #765.
 */
jest.mock('../src/db');
jest.mock('../src/utils/validateEnv', () => jest.fn());
jest.mock('../src/services/stellar', () => ({
  ...jest.requireActual('../src/services/stellar'),
  checkHorizonHealth: jest.fn().mockResolvedValue(true),
  fetchFee: jest.fn().mockResolvedValue(100),
}));
jest.mock('../src/services/email');

process.env.JWT_SECRET = 'test_secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.STELLAR_NETWORK = 'testnet';
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.PLATFORM_FEE_BPS = '250';

const request = require('supertest');
const db = require('../src/db');

beforeEach(() => {
  db.query.mockImplementation((sql) => {
    if (String(sql).includes('SELECT 1')) return Promise.resolve({ rows: [{}] });
    return Promise.resolve({ rows: [] });
  });
  jest.resetModules();
});

// Mock cache and axios for each test
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
jest.mock('../src/utils/cache', () => ({
  get: (...args) => mockCacheGet(...args),
  set: (...args) => mockCacheSet(...args),
  del: jest.fn(),
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ post: (...args) => mockAxiosPost(...args) }));

// Need auth token — mock auth middleware
jest.mock('../src/middleware/auth', () => (req, _res, next) => {
  req.user = { userId: 'test-user' };
  next();
});

const app = require('../src/app');

describe('GET /api/payments/estimate-fees — fee_rate_source paths', () => {
  test('returns fee_rate_source: on-chain when Horizon simulate succeeds', async () => {
    process.env.FEE_DISTRIBUTOR_CONTRACT_ID = 'CTEST123';
    mockAxiosPost.mockResolvedValueOnce({ data: { result: 300 } });
    mockCacheGet.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=100&asset=USDC')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(200);
    expect(res.body.fee_rate_source).toBe('on-chain');
    expect(res.body.fee_rate_bps).toBe(300);
    expect(mockCacheSet).toHaveBeenCalledWith('fee_rate_bps_onchain', 300, 60);
  });

  test('returns fee_rate_source: cached when Horizon simulate fails but cache has value', async () => {
    process.env.FEE_DISTRIBUTOR_CONTRACT_ID = 'CTEST123';
    mockAxiosPost.mockRejectedValueOnce(new Error('Horizon unavailable'));
    mockCacheGet.mockResolvedValueOnce(275);

    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=100&asset=USDC')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(200);
    expect(res.body.fee_rate_source).toBe('cached');
    expect(res.body.fee_rate_bps).toBe(275);
  });

  test('returns fee_rate_source: config_fallback when both on-chain and cache fail', async () => {
    process.env.FEE_DISTRIBUTOR_CONTRACT_ID = 'CTEST123';
    mockAxiosPost.mockRejectedValueOnce(new Error('Horizon unavailable'));
    mockCacheGet.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=100&asset=USDC')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(200);
    expect(res.body.fee_rate_source).toBe('config_fallback');
    expect(res.body.fee_rate_bps).toBe(250);
  });

  test('response includes fee_rate_bps, fee_rate_source, last_fetched_at, and fee_breakdown', async () => {
    process.env.FEE_DISTRIBUTOR_CONTRACT_ID = '';
    mockCacheGet.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/payments/estimate-fees?amount=50&asset=USDC')
      .set('Authorization', 'Bearer test');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('fee_rate_bps');
    expect(res.body).toHaveProperty('fee_rate_source');
    expect(res.body).toHaveProperty('last_fetched_at');
    expect(res.body).toHaveProperty('fee_breakdown');
  });
});
