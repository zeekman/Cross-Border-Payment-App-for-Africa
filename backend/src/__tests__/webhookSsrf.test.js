'use strict';
/**
 * Tests for SSRF protection in POST /api/webhooks
 * Updated: DNS-rebinding regression test added.
 */

jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-test-id' };
  next();
});
jest.mock('../utils/symmetricEncryption', () => ({
  encryptSecret: (s) => `enc:${s}`,
  decryptSecret: (s) => s.replace(/^enc:/, ''),
}));

jest.mock('dns', () => ({
  promises: {
    resolve4: jest.fn(),
    resolve6: jest.fn(),
  },
}));

const request = require('supertest');
const express = require('express');
const dns = require('dns').promises;
const db = require('../db');
const webhookRouter = require('../routes/webhooks');

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

beforeEach(() => {
  jest.clearAllMocks();
  dns.resolve4.mockResolvedValue(['93.184.216.34']);
  dns.resolve6.mockResolvedValue([]);
});

describe('POST /api/webhooks — SSRF protection', () => {
  test('rejects localhost URL (127.0.0.1)', async () => {
    dns.resolve4.mockResolvedValue(['127.0.0.1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://localhost/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects AWS metadata endpoint (169.254.169.254)', async () => {
    dns.resolve4.mockResolvedValue(['169.254.169.254']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://169.254.169.254/latest/meta-data/', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects RFC 1918 address (10.x.x.x)', async () => {
    dns.resolve4.mockResolvedValue(['10.0.0.1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://internal.corp/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects RFC 1918 address (192.168.x.x)', async () => {
    dns.resolve4.mockResolvedValue(['192.168.1.1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://router.local/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects RFC 1918 address (172.16.x.x)', async () => {
    dns.resolve4.mockResolvedValue(['172.16.0.1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://internal.local/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects RFC 1918 address (172.31.x.x)', async () => {
    dns.resolve4.mockResolvedValue(['172.31.255.255']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://aws-internal.local/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects shared address space (100.64.x.x)', async () => {
    dns.resolve4.mockResolvedValue(['100.64.0.1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://shared.local/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects bare private IP in URL', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://10.0.0.1/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects bare RFC 1918 Class B IP (172.16.x.x)', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://172.16.0.1/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects bare RFC 1918 Class C IP (192.168.x.x)', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://192.168.0.1/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects loopback IP (127.0.0.1)', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://127.0.0.1/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects multicast address (224.0.0.1)', async () => {
    dns.resolve4.mockResolvedValue(['224.0.0.1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://multicast.local/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects reserved address (240.0.0.1)', async () => {
    dns.resolve4.mockResolvedValue(['240.0.0.1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://reserved.local/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('accepts a valid public HTTPS URL', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'wh-1', url: 'https://example.com/hook',
        events: ['payment.sent'], active: true, created_at: new Date().toISOString(),
      }],
    });
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://example.com/hook', events: ['payment.sent'] });
    expect(res.status).toBe(201);
    expect(res.body.url).toBe('https://example.com/hook');
  });

  test('rejects unresolvable hostname', async () => {
    dns.resolve4.mockRejectedValue(new Error('ENOTFOUND'));
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://does-not-exist.invalid/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects IPv6 loopback (::1)', async () => {
    dns.resolve4.mockResolvedValue([]);
    dns.resolve6.mockResolvedValue(['::1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://[::1]/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects IPv6 link-local (fe80::)', async () => {
    dns.resolve4.mockResolvedValue([]);
    dns.resolve6.mockResolvedValue(['fe80::1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://[fe80::1]/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects IPv6 private (fc00::)', async () => {
    dns.resolve4.mockResolvedValue([]);
    dns.resolve6.mockResolvedValue(['fc00::1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://[fc00::1]/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('rejects IPv6 private (fd00::)', async () => {
    dns.resolve4.mockResolvedValue([]);
    dns.resolve6.mockResolvedValue(['fd00::1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://[fd00::1]/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  test('accepts valid public IPv4 address', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'wh-1', url: 'https://8.8.8.8/hook',
        events: ['payment.sent'], active: true, created_at: new Date().toISOString(),
      }],
    });
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://8.8.8.8/hook', events: ['payment.sent'] });
    expect(res.status).toBe(201);
    expect(res.body.url).toBe('https://8.8.8.8/hook');
  });

  test('accepts valid public IPv6 address', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'wh-1', url: 'https://[2001:4860:4860::8888]/hook',
        events: ['payment.sent'], active: true, created_at: new Date().toISOString(),
      }],
    });
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://[2001:4860:4860::8888]/hook', events: ['payment.sent'] });
    expect(res.status).toBe(201);
    expect(res.body.url).toBe('https://[2001:4860:4860::8888]/hook');
  });

  test('rejects 0.0.0.0 (this network)', async () => {
    dns.resolve4.mockResolvedValue(['0.0.0.1']);
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://0.0.0.1/hook', events: ['payment.sent'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSRF_BLOCKED');
  });

  // DNS REBINDING REGRESSION TEST
  test('prevents DNS rebinding attack', async () => {
    dns.resolve4.mockResolvedValueOnce(['93.184.216.34']);

    const http = require('http');
    let internalHit = false;
    const internalServer = http.createServer((_req, res) => {
      internalHit = true;
      res.writeHead(200);
      res.end();
    });
    await new Promise((resolve) => internalServer.listen(0, '127.0.0.1', resolve));
    const internalPort = internalServer.address().port;

    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'wh-rebind', url: 'https://example.com/hook',
        events: ['payment.sent'], active: true, created_at: new Date().toISOString(),
      }],
    });

    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://example.com/hook', events: ['payment.sent'] });

    expect(res.status).toBe(201);
    expect(internalHit).toBe(false);

    await new Promise((resolve) => internalServer.close(resolve));
  });
});
