const request = require('supertest');
const express = require('express');
const rateLimit = require('express-rate-limit');

/**
 * Tests for the per-user support ticket creation rate limiter.
 *
 * We build a minimal Express app that mirrors the real support route's
 * rate-limiting setup so we can exercise the 429 behaviour without
 * touching the database.
 */

function buildApp() {
  const app = express();
  app.use(express.json());

  // Simulate auth middleware – attach a fake user object
  app.use((req, _res, next) => {
    req.user = { userId: req.headers['x-test-user-id'] || '1' };
    next();
  });

  const ticketCreationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    keyGenerator: (req) => req.user.userId,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many support tickets created. You may submit up to 5 tickets per hour.',
    },
  });

  app.post('/api/support/tickets', ticketCreationLimiter, (_req, res) => {
    res.status(201).json({ ticket: { id: 1 } });
  });

  return app;
}

describe('Support ticket per-user rate limiter', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  test('allows up to 5 requests within the window', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/support/tickets')
        .set('x-test-user-id', 'user-allow-test')
        .send({ type: 'other', description: 'test' });
      expect(res.status).toBe(201);
    }
  });

  test('returns 429 on the 6th request within the window', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/support/tickets')
        .set('x-test-user-id', 'user-block-test')
        .send({ type: 'other', description: 'test' });
    }

    const res = await request(app)
      .post('/api/support/tickets')
      .set('x-test-user-id', 'user-block-test')
      .send({ type: 'other', description: 'test' });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/too many support tickets/i);
  });

  test('includes Retry-After header when rate limited', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/support/tickets')
        .set('x-test-user-id', 'user-header-test')
        .send({ type: 'other', description: 'test' });
    }

    const res = await request(app)
      .post('/api/support/tickets')
      .set('x-test-user-id', 'user-header-test')
      .send({ type: 'other', description: 'test' });

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  test('rate limits are per-user, not global', async () => {
    // Exhaust limit for user A
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/support/tickets')
        .set('x-test-user-id', 'user-A')
        .send({ type: 'other', description: 'test' });
    }

    // User A should be blocked
    const blockedRes = await request(app)
      .post('/api/support/tickets')
      .set('x-test-user-id', 'user-A')
      .send({ type: 'other', description: 'test' });
    expect(blockedRes.status).toBe(429);

    // User B should still be allowed
    const allowedRes = await request(app)
      .post('/api/support/tickets')
      .set('x-test-user-id', 'user-B')
      .send({ type: 'other', description: 'test' });
    expect(allowedRes.status).toBe(201);
  });
});
