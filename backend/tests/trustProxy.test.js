const express = require('express');
const request = require('supertest');
const { resolveTrustProxy } = require('../src/utils/trustProxy');

const silentLogger = { info: jest.fn(), error: jest.fn() };

function buildApp(env) {
  const app = express();
  app.set('trust proxy', resolveTrustProxy(env, silentLogger));
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  return app;
}

describe('resolveTrustProxy', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ignores a spoofed X-Forwarded-For from an untrusted peer', async () => {
    const res = await request(buildApp({})).get('/ip').set('X-Forwarded-For', '203.0.113.9');
    expect(res.body.ip).not.toBe('203.0.113.9');
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it('ignores X-Forwarded-For when the peer is not in the trusted list', async () => {
    const res = await request(buildApp({ TRUSTED_PROXIES: '10.0.0.0/8' }))
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.9');
    expect(res.body.ip).not.toBe('203.0.113.9');
  });

  it('parses hop counts and lists', () => {
    expect(resolveTrustProxy({ TRUSTED_PROXIES: '1' }, silentLogger)).toBe(1);
    expect(resolveTrustProxy({ TRUSTED_PROXIES: '10.0.0.1, 10.0.0.0/8' }, silentLogger)).toEqual([
      '10.0.0.1',
      '10.0.0.0/8',
    ]);
    expect(resolveTrustProxy({}, silentLogger)).toBe(false);
  });

  it('rejects TRUSTED_PROXIES=true in production', () => {
    expect(() =>
      resolveTrustProxy({ TRUSTED_PROXIES: 'true', NODE_ENV: 'production' }, silentLogger)
    ).toThrow();
  });

  it('ignores legacy TRUST_PROXY and logs a deprecation error', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: 'true', NODE_ENV: 'production' }, silentLogger)).toBe(
      false
    );
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('TRUST_PROXY is deprecated')
    );
  });
});
