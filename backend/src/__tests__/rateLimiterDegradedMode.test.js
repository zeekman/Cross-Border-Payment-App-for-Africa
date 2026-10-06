'use strict';

/**
 * Tests for issue #952 (BE-005): when the rate limiter's Redis store is
 * unavailable, express-rate-limit falls back to per-process in-memory
 * limiting. This must not fail silently — a warning log and a Prometheus
 * metric must fire on the first failure and periodically while degraded,
 * and the health-check surface must be able to report which mode each
 * limiter is in.
 */

jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

describe('RedisStore degraded-mode alerting', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  function mockFailingRedis() {
    jest.mock('ioredis', () =>
      jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        multi: () => ({
          incr: jest.fn(),
          ttl: jest.fn(),
          exec: jest.fn().mockRejectedValue(new Error('connection refused')),
        }),
      }))
    );
  }

  test('first Redis failure: falls back to in-memory counting, logs a warning, and sets the degraded metric', async () => {
    mockFailingRedis();
    const logger = require('../utils/logger');
    const metrics = require('../utils/metrics');
    const { RedisStore, getRateLimiterStatus } = require('../middleware/rateLimiter');

    const store = new RedisStore(60000, 'auth');
    const result = await store.increment('1.2.3.4');

    expect(result).toEqual(expect.objectContaining({ totalHits: 1 }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('degraded'),
      expect.objectContaining({ prefix: 'auth', reason: 'redis_error' })
    );

    const degradedMetric = await metrics.rateLimiterDegraded.get();
    expect(degradedMetric.values).toContainEqual(
      expect.objectContaining({ labels: { prefix: 'auth' }, value: 1 })
    );

    const failuresMetric = await metrics.rateLimiterRedisFailuresTotal.get();
    expect(failuresMetric.values).toContainEqual(
      expect.objectContaining({ labels: { prefix: 'auth', reason: 'redis_error' }, value: 1 })
    );

    expect(getRateLimiterStatus().auth).toBe('memory-fallback');
  });

  test('repeated failures within the alert interval do not re-log, but the counter keeps incrementing', async () => {
    mockFailingRedis();
    const logger = require('../utils/logger');
    const metrics = require('../utils/metrics');
    const { RedisStore } = require('../middleware/rateLimiter');

    const store = new RedisStore(60000, 'auth');
    await store.increment('1.2.3.4');
    await store.increment('1.2.3.4');
    await store.increment('1.2.3.4');

    expect(logger.warn).toHaveBeenCalledTimes(1); // still just the initial transition

    const failuresMetric = await metrics.rateLimiterRedisFailuresTotal.get();
    expect(failuresMetric.values).toContainEqual(
      expect.objectContaining({ labels: { prefix: 'auth', reason: 'redis_error' }, value: 3 })
    );
  });

  test('logs again once the degraded interval elapses while still failing', async () => {
    mockFailingRedis();
    const logger = require('../utils/logger');
    const { RedisStore } = require('../middleware/rateLimiter');

    const store = new RedisStore(60000, 'auth');
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);

    await store.increment('1.2.3.4');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(realNow + 6 * 60 * 1000); // past the 5-minute interval
    await store.increment('1.2.3.4');
    expect(logger.warn).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  test('recovers: a successful Redis call after an outage clears the degraded state and logs recovery', async () => {
    let mockShouldFail = true;
    jest.mock('ioredis', () =>
      jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        multi: () => ({
          incr: jest.fn(),
          ttl: jest.fn(),
          exec: jest.fn().mockImplementation(() => {
            if (mockShouldFail) return Promise.reject(new Error('connection refused'));
            return Promise.resolve([
              [null, 1],
              [null, 60],
            ]);
          }),
        }),
        expire: jest.fn(),
      }))
    );

    const logger = require('../utils/logger');
    const metrics = require('../utils/metrics');
    const { RedisStore, getRateLimiterStatus } = require('../middleware/rateLimiter');

    const store = new RedisStore(60000, 'auth');
    await store.increment('1.2.3.4');
    expect(getRateLimiterStatus().auth).toBe('memory-fallback');

    mockShouldFail = false;
    const result = await store.increment('1.2.3.4');

    expect(result).not.toBeNull();
    expect(getRateLimiterStatus().auth).toBe('redis');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('recovered'),
      expect.objectContaining({ prefix: 'auth' })
    );

    const degradedMetric = await metrics.rateLimiterDegraded.get();
    expect(degradedMetric.values).toContainEqual(
      expect.objectContaining({ labels: { prefix: 'auth' }, value: 0 })
    );
  });
});
