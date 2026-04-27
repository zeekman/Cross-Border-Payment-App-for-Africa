'use strict';
/**
 * Tests for SSRF protection in POST /api/webhooks (issue #261)
 */

jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-test-id' };
  next();
});

// Mock dns.lookup so tests don't make real network calls
jest.mock('dns', () => ({
  promises: {
    lookup: jest.fn(),
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
  // Default: resolve to a public IP
  dns.lookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
});

describe('POST /api/webhooks — SSRF protection', () => {
  test('rejects http:// URLs', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'http://example.com/hook', events: ['payment.sent'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/public HTTPS endpoint/i);
  });

  test('rejects localhost URL', async () => {
    dns.lookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });

    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://localhost/hook', events: ['payment.sent'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/public HTTPS endpoint/i);
  });

  test('rejects AWS metadata endpoint (169.254.169.254)', async () => {
    dns.lookup.mockResolvedValue({ address: '169.254.169.254', family: 4 });

    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://169.254.169.254/latest/meta-data/', events: ['payment.sent'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/public HTTPS endpoint/i);
  });

  test('rejects RFC 1918 address (10.x.x.x)', async () => {
    dns.lookup.mockResolvedValue({ address: '10.0.0.1', family: 4 });

    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://internal.corp/hook', events: ['payment.sent'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/public HTTPS endpoint/i);
  });

  test('rejects RFC 1918 address (192.168.x.x)', async () => {
    dns.lookup.mockResolvedValue({ address: '192.168.1.1', family: 4 });

    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://router.local/hook', events: ['payment.sent'] });

    expect(res.status).toBe(400);
  });

  test('rejects bare private IP in URL', async () => {
    // dns.lookup won't be called for bare IPs — the IP check runs first
    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://10.0.0.1/hook', events: ['payment.sent'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/public HTTPS endpoint/i);
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
    dns.lookup.mockRejectedValue(new Error('ENOTFOUND'));

    const res = await request(app)
      .post('/api/webhooks')
      .send({ url: 'https://does-not-exist.invalid/hook', events: ['payment.sent'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/public HTTPS endpoint/i);
  });
});
