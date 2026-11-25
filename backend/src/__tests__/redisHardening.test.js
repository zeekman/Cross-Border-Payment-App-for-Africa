'use strict';
/**
 * BE-172 / BE-173 / BE-174: Redis-backed security features and error handling.
 */

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockState = { failing: false, options: null };

jest.mock('ioredis', () => {
  function MockRedis(_url, options) {
    mockState.options = options;
    this.on = jest.fn();
    this.get = jest.fn(async () => {
      if (mockState.failing) throw new Error('Connection is closed.');
      return null;
    });
    this.set = jest.fn(async () => {
      if (mockState.failing) throw new Error('Connection is closed.');
      return 'OK';
    });
    this.eval = jest.fn(async () => 1);
  }
  return MockRedis;
});

beforeEach(() => {
  jest.resetModules();
  mockState.failing = false;
  process.env.REDIS_URL = 'redis://localhost:6379';
});

afterEach(() => {
  delete process.env.REDIS_URL;
});

describe('shared Redis client (BE-173)', () => {
  test('queues commands while connecting instead of rejecting the first one', () => {
    require('../utils/redisClient').getRedisClient();
    expect(mockState.options.enableOfflineQueue).toBe(true);
    expect(mockState.options.lazyConnect).toBeUndefined();
  });

  test('cache and distributed lock share one connection', () => {
    const { getRedisClient } = require('../utils/redisClient');
    expect(require('../utils/cache').getClient()).toBe(getRedisClient());
  });

  test('first lock acquisition after startup succeeds', async () => {
    const { withLock } = require('../utils/distributedLock');
    await expect(withLock('lock:first', 10, async () => {})).resolves.toBe(true);
  });

  test('withLock throws 503 LOCK_UNAVAILABLE when Redis is unreachable', async () => {
    mockState.failing = true;
    const { withLock } = require('../utils/distributedLock');
    await expect(withLock('lock:down', 10, async () => {}, { throwOnError: true })).rejects.toMatchObject({
      status: 503,
      payload: { code: 'LOCK_UNAVAILABLE' },
    });
  });
});

describe('token revocation (BE-172)', () => {
  test('fails closed when Redis is down', async () => {
    mockState.failing = true;
    const cache = require('../utils/cache');
    await expect(cache.getStrict('jti:blacklist:abc')).rejects.toThrow();
  });

  test('without REDIS_URL, revocation and challenges use the in-process fallback', async () => {
    delete process.env.REDIS_URL;
    const cache = require('../utils/cache');
    await cache.set('jti:blacklist:abc', 1, 60);
    await cache.set('webauthn:reg:u1', 'challenge', 60);
    expect(await cache.getStrict('jti:blacklist:abc')).toBe(1);
    expect(await cache.get('webauthn:reg:u1')).toBe('challenge');
  });
});

describe('global error handler (BE-174)', () => {
  function buildApp(err) {
    const express = require('express');
    const errorHandler = require('../middleware/errorHandler');
    const app = express();
    app.use((req, res, next) => {
      req.requestId = 'req-123';
      next();
    });
    app.get('/boom', () => {
      throw err;
    });
    app.use(errorHandler);
    return app;
  }

  test('does not leak internal 500 messages', async () => {
    const request = require('supertest');
    const res = await request(buildApp(new Error('relation "foo" does not exist'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error', request_id: 'req-123' });
  });

  test('intentional 4xx errors keep their message', async () => {
    const request = require('supertest');
    const err = Object.assign(new Error('Amount must be positive'), { status: 400 });
    const res = await request(buildApp(err)).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Amount must be positive');
  });
});
