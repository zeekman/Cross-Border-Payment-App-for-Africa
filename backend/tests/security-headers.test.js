jest.mock('../src/db');
jest.mock('../src/services/stellar');
jest.mock('../src/services/email');
jest.mock('../src/utils/validateEnv', () => jest.fn());

process.env.JWT_SECRET = 'test_secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.STELLAR_NETWORK = 'testnet';
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';

const request = require('supertest');
const app = require('../src/app');

const SECURITY_HEADERS = [
  'x-dns-prefetch-control',
  'x-frame-options',
  'x-content-type-options',
  'x-xss-protection',
  'strict-transport-security',
  'content-security-policy',
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

  test('CSP restricts default-src to self', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  test('CSP blocks framing (frame-src none)', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toContain("frame-src 'none'");
  });

  test('CSP blocks object-src', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toContain("object-src 'none'");
  });
});
