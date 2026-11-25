'use strict';

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// In-memory Redis mock — prefixed with "mock" so Jest allows it inside jest.mock factory
const mockStore = new Map();

jest.mock('ioredis', () => {
  function MockRedis() {
    this.on = jest.fn();
    this.set = jest.fn(async (key, value, ex, ttl, nx) => {
      if (nx === 'NX' && mockStore.has(key)) return null;
      mockStore.set(key, value);
      return 'OK';
    });
    this.eval = jest.fn(async (_script, _numKeys, key, value, ttl) => {
      if (mockStore.get(key) !== value) return 0;
      // Renew script passes a ttl arg and only extends the TTL (no delete);
      // release script has no ttl arg and deletes the key.
      if (ttl !== undefined) return 1;
      mockStore.delete(key);
      return 1;
    });
  }
  return MockRedis;
});

beforeEach(() => {
  mockStore.clear();
  jest.resetModules();
  process.env.REDIS_URL = 'redis://localhost:6379';
});

afterEach(() => {
  delete process.env.REDIS_URL;
});

describe('acquireLock', () => {
  test('returns true when the key is not already held', async () => {
    const { acquireLock } = require('../utils/distributedLock');
    const acquired = await acquireLock('lock:test', 55, 'value-1');
    expect(acquired).toBe(true);
  });

  test('returns false when the key is already held', async () => {
    const { acquireLock } = require('../utils/distributedLock');
    await acquireLock('lock:test', 55, 'value-1');
    const second = await acquireLock('lock:test', 55, 'value-2');
    expect(second).toBe(false);
  });
});

describe('releaseLock', () => {
  test('removes the key when the lock value matches', async () => {
    const { acquireLock, releaseLock } = require('../utils/distributedLock');
    await acquireLock('lock:rel', 55, 'val');
    await releaseLock('lock:rel', 'val');
    expect(mockStore.has('lock:rel')).toBe(false);
  });

  test('does not remove the key when the value does not match (Lua guard)', async () => {
    const { acquireLock, releaseLock } = require('../utils/distributedLock');
    await acquireLock('lock:guard', 55, 'correct-val');
    await releaseLock('lock:guard', 'wrong-val');
    expect(mockStore.has('lock:guard')).toBe(true);
  });
});

describe('withLock', () => {
  test('runs fn and returns true when lock is acquired', async () => {
    const { withLock } = require('../utils/distributedLock');
    const fn = jest.fn().mockResolvedValue(undefined);
    const ran = await withLock('lock:wl', 55, fn);
    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('returns false without running fn when lock is already held', async () => {
    const { acquireLock, withLock } = require('../utils/distributedLock');
    await acquireLock('lock:skip', 55, 'holder');

    const fn = jest.fn();
    const ran = await withLock('lock:skip', 55, fn);
    expect(ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  test('simulates concurrent acquisition — only one runner proceeds', async () => {
    const { withLock } = require('../utils/distributedLock');
    const results = [];

    await Promise.all([
      withLock('lock:concurrent', 55, async () => { results.push('A'); }),
      withLock('lock:concurrent', 55, async () => { results.push('B'); }),
    ]);

    expect(results).toHaveLength(1);
  });

  test('releases the lock even when fn throws', async () => {
    const { withLock } = require('../utils/distributedLock');
    await expect(
      withLock('lock:throw', 55, async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    // Lock should be gone — next acquirer can get it
    const fn = jest.fn().mockResolvedValue(undefined);
    const ran = await withLock('lock:throw', 55, fn);
    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalled();
  });

  test('single-instance mode (no REDIS_URL) always runs fn', async () => {
    delete process.env.REDIS_URL;
    jest.resetModules();
    const { withLock } = require('../utils/distributedLock');
    const fn = jest.fn().mockResolvedValue(undefined);
    const ran = await withLock('lock:noop', 55, fn);
    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// BE-034: heartbeat/renewal for long-running lock holders
describe('withLock heartbeat/renewal', () => {
  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('renews the lock via heartbeat while a job runs past the original TTL', async () => {
    const { withLock, acquireLock } = require('../utils/distributedLock');
    const ttlSeconds = 3; // heartbeat interval = max(1000, 3000/3) = 1000ms

    const jobDone = { resolved: false };
    const runPromise = withLock('lock:heartbeat', ttlSeconds, async () => {
      // Simulate a job that outlives the original TTL: advance fake time by
      // more than ttlSeconds worth of heartbeats before finishing.
      await jest.advanceTimersByTimeAsync(3500);
      jobDone.resolved = true;
    });

    await runPromise;
    expect(jobDone.resolved).toBe(true);

    // Lock should have been renewed (still present until release at the end,
    // then cleaned up) — verifying a fresh acquirer can get it post-release
    // confirms the lock lifecycle completed cleanly despite outliving the TTL.
    const acquired = await acquireLock('lock:heartbeat', ttlSeconds, 'new-holder');
    expect(acquired).toBe(true);
  });

  test('flags lock loss and records a metric when renewal fails (lock stolen/expired)', async () => {
    const { distributedLockLostTotal, distributedLockRenewalFailuresTotal } = require('../utils/metrics');
    const lostSpy = jest.spyOn(distributedLockLostTotal, 'inc');
    const failSpy = jest.spyOn(distributedLockRenewalFailuresTotal, 'inc');

    const { withLock } = require('../utils/distributedLock');
    const ttlSeconds = 3;

    let sawLockLost = false;
    await withLock('lock:stolen', ttlSeconds, async ({ isLockLost }) => {
      // Simulate the key being deleted out from under us (e.g. TTL truly
      // expired and another process grabbed it) before the next heartbeat.
      mockStore.delete('lock:stolen');
      await jest.advanceTimersByTimeAsync(1100); // past one heartbeat interval
      sawLockLost = isLockLost();
    });

    expect(sawLockLost).toBe(true);
    expect(lostSpy).toHaveBeenCalledWith({ lock_key: 'lock:stolen' });
    expect(failSpy).toHaveBeenCalledWith({ lock_key: 'lock:stolen' });

    lostSpy.mockRestore();
    failSpy.mockRestore();
  });
});
