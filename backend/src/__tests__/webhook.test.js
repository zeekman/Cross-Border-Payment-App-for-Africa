'use strict';

/**
 * Tests for backend/src/services/webhook.js
 *
 * Covers:
 *  - sign()           : HMAC-SHA256 signature correctness
 *  - deliverWithRetry : success path, retry-then-succeed, permanent failure logging
 *  - deliver()        : DB query, fan-out to multiple subscribers
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

jest.mock('../db', () => ({ query: jest.fn() }));

// We mock the built-in https module so no real network calls are made.
jest.mock('https', () => {
  const EventEmitter = require('events');

  // __mockImpl is replaced per-test to control what httpsPost resolves/rejects with.
  let __mockImpl = null;

  function request(_options, callback) {
    const req = new EventEmitter();
    req.write = jest.fn();
    req.end = jest.fn(() => {
      if (__mockImpl) {
        __mockImpl(callback, req);
      }
    });
    return req;
  }

  return { request, __setImpl: (fn) => { __mockImpl = fn; } };
});

// Speed up exponential-backoff delays in all tests.
jest.useFakeTimers();

// ── Helpers ──────────────────────────────────────────────────────────────────

const https = require('https');
const logger = require('../utils/logger');
const db = require('../db');

/**
 * Configure https.request to respond with a given HTTP status code.
 */
function mockHttpStatus(statusCode) {
  const EventEmitter = require('events');
  https.__setImpl((callback) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.resume = jest.fn();
    callback(res);
  });
}

/**
 * Configure https.request to emit a network-level error (e.g. ECONNREFUSED).
 */
function mockNetworkError(message = 'ECONNREFUSED') {
  https.__setImpl((_callback, req) => {
    req.emit('error', new Error(message));
  });
}

// Flush all pending timers AND microtasks so async retries complete.
async function runTimers() {
  await jest.runAllTimersAsync();
}

// ── Tests ────────────────────────────────────────────────────────────────────

// Re-require after mocks are in place.
const { deliver, sign, MAX_ATTEMPTS } = require('../services/webhook');

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── sign() ──────────────────────────────────────────────────────────────────

describe('sign()', () => {
  test('returns a hex string', () => {
    const result = sign('secret', 'payload');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is deterministic for the same inputs', () => {
    expect(sign('s', 'p')).toBe(sign('s', 'p'));
  });

  test('differs when secret changes', () => {
    expect(sign('secret-A', 'payload')).not.toBe(sign('secret-B', 'payload'));
  });

  test('differs when payload changes', () => {
    expect(sign('secret', 'payload-A')).not.toBe(sign('secret', 'payload-B'));
  });

  test('produces the correct HMAC-SHA256 value', () => {
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', 'mysecret').update('mybody').digest('hex');
    expect(sign('mysecret', 'mybody')).toBe(expected);
  });
});

// ─── deliverWithRetry() — success ────────────────────────────────────────────

describe('deliverWithRetry() — success on first attempt', () => {
  test('resolves without logging warnings or errors', async () => {
    mockHttpStatus(200);
    db.query.mockResolvedValue({ rows: [{ url: 'https://example.com/hook', secret: 'sec' }] });

    const promise = deliver('payment.sent', { amount: '10' });
    await runTimers();
    await promise;

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('accepts any 2xx status code (201, 204)', async () => {
    for (const status of [201, 204]) {
      jest.clearAllMocks();
      mockHttpStatus(status);
      db.query.mockResolvedValue({ rows: [{ url: 'https://example.com/hook', secret: 'sec' }] });

      const promise = deliver('payment.sent', {});
      await runTimers();
      await promise;

      expect(logger.error).not.toHaveBeenCalled();
    }
  });
});

// ─── deliverWithRetry() — retry then succeed ─────────────────────────────────

describe('deliverWithRetry() — retries before succeeding', () => {
  test('logs a warn on each failed attempt before eventual success', async () => {
    let callCount = 0;
    https.__setImpl((callback, req) => {
      callCount++;
      const EventEmitter = require('events');
      if (callCount < MAX_ATTEMPTS) {
        // Fail for the first (MAX_ATTEMPTS - 1) calls
        req.emit('error', new Error('ETIMEDOUT'));
      } else {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = jest.fn();
        callback(res);
      }
    });

    db.query.mockResolvedValue({ rows: [{ url: 'https://example.com/hook', secret: 'sec' }] });

    const promise = deliver('payment.sent', {});
    await runTimers();
    await promise;

    expect(logger.warn).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('warn message includes url, attempt number, and error', async () => {
    let callCount = 0;
    https.__setImpl((callback, req) => {
      callCount++;
      const EventEmitter = require('events');
      if (callCount === 1) {
        req.emit('error', new Error('ECONNRESET'));
      } else {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = jest.fn();
        callback(res);
      }
    });

    db.query.mockResolvedValue({ rows: [{ url: 'https://hooks.example.com/cb', secret: 'x' }] });

    const promise = deliver('payment.received', {});
    await runTimers();
    await promise;

    const [msg, meta] = logger.warn.mock.calls[0];
    expect(msg).toMatch(/retrying/i);
    expect(meta).toMatchObject({
      url: 'https://hooks.example.com/cb',
      attempt: 1,
      maxAttempts: MAX_ATTEMPTS,
      error: 'ECONNRESET',
    });
  });
});

// ─── deliverWithRetry() — permanent failure ───────────────────────────────────

describe('deliverWithRetry() — permanent failure after max retries', () => {
  test('calls logger.error exactly once after exhausting all retries', async () => {
    mockNetworkError('ECONNREFUSED');
    db.query.mockResolvedValue({ rows: [{ url: 'https://example.com/hook', secret: 'sec' }] });

    const promise = deliver('payment.failed', { txId: 'abc' });
    await runTimers();
    await promise;

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test('error log includes url, event name, attempt count, and error message', async () => {
    mockNetworkError('ETIMEDOUT');
    db.query.mockResolvedValue({ rows: [{ url: 'https://hooks.example.com/pay', secret: 'sec' }] });

    const promise = deliver('payment.sent', { amount: '50' });
    await runTimers();
    await promise;

    const [msg, meta] = logger.error.mock.calls[0];
    expect(msg).toMatch(/permanently failed/i);
    expect(meta).toMatchObject({
      url: 'https://hooks.example.com/pay',
      event: 'payment.sent',
      attempts: MAX_ATTEMPTS,
      error: 'ETIMEDOUT',
    });
  });

  test('also logs error on non-2xx HTTP responses after max retries', async () => {
    mockHttpStatus(500);
    db.query.mockResolvedValue({ rows: [{ url: 'https://example.com/hook', secret: 'sec' }] });

    const promise = deliver('payment.failed', {});
    await runTimers();
    await promise;

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ attempts: MAX_ATTEMPTS });
  });

  test('deliver() still resolves (does not throw) even when all webhooks fail', async () => {
    mockNetworkError('ECONNREFUSED');
    db.query.mockResolvedValue({ rows: [{ url: 'https://example.com/hook', secret: 'sec' }] });

    const promise = deliver('payment.sent', {});
    await runTimers();
    await expect(promise).resolves.toBeUndefined();
  });

  test('warn is logged for intermediate retries before the final error', async () => {
    mockNetworkError('ECONNREFUSED');
    db.query.mockResolvedValue({ rows: [{ url: 'https://example.com/hook', secret: 'sec' }] });

    const promise = deliver('payment.sent', {});
    await runTimers();
    await promise;

    // (MAX_ATTEMPTS - 1) warn calls, then 1 error call
    expect(logger.warn).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

// ─── deliver() — fan-out & DB interaction ────────────────────────────────────

describe('deliver() — fan-out to multiple subscribers', () => {
  test('queries DB for active webhooks matching the event', async () => {
    mockHttpStatus(200);
    db.query.mockResolvedValue({ rows: [] });

    const promise = deliver('payment.sent', {});
    await runTimers();
    await promise;

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE active = true'),
      ['payment.sent']
    );
  });

  test('delivers to every active subscriber', async () => {
    mockHttpStatus(200);
    db.query.mockResolvedValue({
      rows: [
        { url: 'https://a.example.com/hook', secret: 'sec-a' },
        { url: 'https://b.example.com/hook', secret: 'sec-b' },
        { url: 'https://c.example.com/hook', secret: 'sec-c' },
      ],
    });

    const postSpy = jest.spyOn(require('https'), 'request');

    const promise = deliver('payment.received', { amount: '100' });
    await runTimers();
    await promise;

    // One https.request call per subscriber
    expect(postSpy).toHaveBeenCalledTimes(3);
    postSpy.mockRestore();
  });

  test('delivers to zero subscribers without error when none match', async () => {
    db.query.mockResolvedValue({ rows: [] });

    const promise = deliver('payment.sent', {});
    await runTimers();
    await expect(promise).resolves.toBeUndefined();
  });

  test('payload sent to subscriber includes event, data, and ISO timestamp', async () => {
    // httpsPost calls req.write(body) then req.end().
    // Our mock fires the response inside req.end, so we capture body via write spy
    // set up BEFORE request() is called. We do this by patching https.request directly.
    const EventEmitter = require('events');
    const capturedBodies = [];

    jest.spyOn(https, 'request').mockImplementation((_options, callback) => {
      const req = new EventEmitter();
      req.write = jest.fn((body) => capturedBodies.push(body));
      req.end = jest.fn(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = jest.fn();
        callback(res);
      });
      return req;
    });

    db.query.mockResolvedValue({ rows: [{ url: 'https://example.com/hook', secret: 'sec' }] });

    const promise = deliver('payment.sent', { txId: 'xyz-123' });
    await runTimers();
    await promise;

    expect(capturedBodies).toHaveLength(1);
    const parsed = JSON.parse(capturedBodies[0]);
    expect(parsed).toMatchObject({ event: 'payment.sent', data: { txId: 'xyz-123' } });
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    jest.restoreAllMocks();
  });
});
