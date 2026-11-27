/**
 * BE-192: /api/wallet used to be mounted twice — first without geoRestriction —
 * so every wallet request skipped the sanctions check. These tests go through
 * the real app.js mount order to make sure a blocked-country request to the
 * wallet surface (and the deprecated /api/wallet/contacts alias) is rejected
 * before it reaches the wallet router.
 */

// Must be set before geoRestriction is loaded (it caches the list at startup).
process.env.BLOCKED_COUNTRIES = 'KP';
process.env.JWT_SECRET = 'test_secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.STELLAR_NETWORK = 'testnet';
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';

jest.mock('geoip-lite', () => ({ lookup: jest.fn() }));
jest.mock('../src/db');
jest.mock('../src/services/email');
jest.mock('../src/services/audit', () => {
  const actual = jest.requireActual('../src/services/audit');
  return { ...actual, auditLog: jest.fn().mockResolvedValue(undefined) };
});
jest.mock('../src/utils/validateEnv', () => jest.fn());

const request = require('supertest');
const geoip = require('geoip-lite');
const db = require('../src/db');
const app = require('../src/app');

beforeEach(() => {
  geoip.lookup.mockReset();
  db.query.mockResolvedValue({ rows: [] });
});

describe('BE-192: /api/wallet is geo-restricted', () => {
  test('POST /api/wallet/create from a blocked country returns 451', async () => {
    geoip.lookup.mockReturnValue({ country: 'KP' });

    const res = await request(app).post('/api/wallet/create').send({});

    expect([451, 403]).toContain(res.status);
    expect(res.body).toEqual({ error: 'Service unavailable in your jurisdiction' });
  });

  test('deprecated /api/wallet/contacts alias from a blocked country returns 451', async () => {
    geoip.lookup.mockReturnValue({ country: 'KP' });

    const res = await request(app).get('/api/wallet/contacts');

    expect([451, 403]).toContain(res.status);
  });

  test('POST /api/wallet/create from an allowed country reaches the wallet router', async () => {
    geoip.lookup.mockReturnValue({ country: 'NG' });

    const res = await request(app).post('/api/wallet/create').send({});

    // No token — the wallet router's auth middleware rejects it, which proves
    // geoRestriction passed the request through to the (single) wallet mount.
    expect(res.status).not.toBe(451);
    expect(res.status).toBe(401);
  });
});
