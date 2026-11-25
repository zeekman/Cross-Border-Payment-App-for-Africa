jest.mock('../src/db');
jest.mock('../src/services/stellar', () => {
  const actual = jest.requireActual('../src/services/stellar');
  return {
    ...actual,
    checkHorizonHealth: jest.fn().mockResolvedValue(true),
  };
});
jest.mock('../src/services/email');
jest.mock('../src/utils/validateEnv', () => jest.fn());

process.env.JWT_SECRET = 'test_secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.STELLAR_NETWORK = 'testnet';
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';

const request = require('supertest');
const db = require('../src/db');

beforeEach(() => {
  db.query.mockImplementation((sql) => {
    if (String(sql).includes('SELECT 1')) return Promise.resolve({ rows: [{}] });
    return Promise.resolve({ rows: [] });
  });
});

const app = require('../src/app');

const SECURITY_HEADERS = [
  'x-dns-prefetch-control',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
  'content-security-policy',
  'permissions-policy',
  'referrer-policy',
];

const ROUTES = [
  { method: 'post', path: '/api/auth/login' },
  { method: 'get',  path: '/health' },
];

describe('CORS preflight', () => {
  test('OPTIONS request returns Access-Control-Max-Age: 86400', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  test('OPTIONS request still restricts origin', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'http://evil.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).not.toBe('http://evil.com');
  });
});

describe('Security headers', () => {
  test.each(ROUTES)('$method $path has required security headers', async ({ method, path }) => {
    const res = await request(app)[method](path).send({});
    SECURITY_HEADERS.forEach(header => {
      expect(res.headers).toHaveProperty(header);
    });
  });

  test('CSP sets default-src to none', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  test('CSP allows scripts from self only', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });

  test('CSP does not contain unsafe-inline', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).not.toContain("'unsafe-inline'");
  });

  test('CSP contains a per-request nonce in script-src', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]+=*'/);
  });

  test('CSP allows connections to self and Stellar Horizon', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain('https://horizon.stellar.org');
    expect(csp).toContain('wss://horizon.stellar.org');
  });

  test('CSP allows images from self and data URIs', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toContain("img-src 'self'");
    expect(res.headers['content-security-policy']).toContain('data:');
  });

  test('CSP blocks framing via frame-ancestors none', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  test('X-Frame-Options is DENY', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  test('HSTS sets max-age with includeSubDomains and preload', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['strict-transport-security']).toContain('includeSubDomains');
    expect(res.headers['strict-transport-security']).toContain('preload');
  });

  test('Permissions-Policy disables camera, microphone, geolocation, payment', async () => {
    const res = await request(app).get('/health');
    const pp = res.headers['permissions-policy'];
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('payment=()');
  });

  test('Referrer-Policy is strict-origin-when-cross-origin', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('X-Content-Type-Options is nosniff', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
