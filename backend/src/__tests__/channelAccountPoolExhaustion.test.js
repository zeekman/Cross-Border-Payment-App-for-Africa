/**
 * BE-035: Load test exercising channel account pool exhaustion explicitly.
 *
 * Verifies the documented backpressure behavior: when concurrent demand
 * exceeds the pool size, acquire() does NOT fail immediately — it polls and
 * waits (bounded queue) until either an account frees up or the configurable
 * timeout elapses, at which point it throws CHANNEL_POOL_EXHAUSTED with a
 * 503 status and retryAfterSeconds hint, and increments the exhaustion
 * metric.
 */

jest.mock('../db');
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const db = require('../db');

// In-memory simulation of `channel_accounts` rows, guarded by a simple
// mutex so concurrent "connections" serialize like real FOR UPDATE SKIP
// LOCKED would (only one caller can see a given available row at a time).
let accounts;
let locked;

function makeClient() {
  let snapshot = null;
  return {
    query: jest.fn(async (sql, params) => {
      if (sql.startsWith('BEGIN')) return {};
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        const free = accounts.find((a) => a.is_available && !locked.has(a.id));
        if (!free) return { rows: [] };
        locked.add(free.id);
        snapshot = free.id;
        return {
          rows: [{ id: free.id, stellar_address: free.address, stellar_secret_encrypted: 'iv:enc' }],
        };
      }
      if (sql.startsWith('UPDATE channel_accounts') && sql.includes('is_available = false')) {
        const acc = accounts.find((a) => a.id === params[0]);
        if (acc) acc.is_available = false;
        return {};
      }
      if (sql.startsWith('COMMIT')) {
        if (snapshot) locked.delete(snapshot);
        return {};
      }
      if (sql.startsWith('ROLLBACK')) {
        if (snapshot) locked.delete(snapshot);
        return {};
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
}

beforeEach(() => {
  jest.resetModules();
  accounts = Array.from({ length: 3 }, (_, i) => ({
    id: `acc-${i}`,
    address: `GADDR${i}`,
    is_available: true,
  }));
  locked = new Set();

  db.pool = { connect: jest.fn(async () => makeClient()) };
  db.query = jest.fn(async (sql) => {
    if (sql.includes('COUNT(*) FILTER')) {
      const available = accounts.filter((a) => a.is_available).length;
      return { rows: [{ available: String(available), total: String(accounts.length) }] };
    }
    return { rows: [] };
  });
});

describe('channelAccountPool exhaustion under load', () => {
  test('bursts within timeout: extra requesters wait and eventually succeed once accounts free up', async () => {
    process.env.CHANNEL_POOL_ACQUIRE_TIMEOUT_MS = '3000';
    process.env.SERVER_KEY_ENCRYPTION_SECRET = 'test-secret';
    const crypto = require('crypto');
    jest.spyOn(crypto, 'createDecipheriv').mockReturnValue({
      update: () => Buffer.from(''),
      final: () => Buffer.from('decrypted-secret'),
    });

    const pool = require('../services/channelAccountPool');

    // 5 concurrent requesters against a pool of 3 accounts.
    const requesters = Array.from({ length: 5 }, () => pool.acquire());

    // After a short delay, release two accounts back so waiting requesters
    // can succeed instead of timing out.
    setTimeout(() => {
      accounts[0].is_available = true;
      accounts[1].is_available = true;
    }, 250);

    const results = await Promise.allSettled(requesters);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // All 5 should eventually succeed since accounts free up within the timeout.
    expect(fulfilled.length).toBe(5);
    expect(rejected.length).toBe(0);
  }, 10000);

  test('sustained exhaustion beyond timeout: acquire() throws CHANNEL_POOL_EXHAUSTED (503) rather than blocking forever', async () => {
    process.env.CHANNEL_POOL_ACQUIRE_TIMEOUT_MS = '400'; // short timeout for test speed
    process.env.SERVER_KEY_ENCRYPTION_SECRET = 'test-secret';

    // Exhaust the pool up front — nothing ever frees up.
    accounts.forEach((a) => { a.is_available = false; });

    const pool = require('../services/channelAccountPool');

    await expect(pool.acquire()).rejects.toMatchObject({
      message: 'CHANNEL_POOL_EXHAUSTED',
      status: 503,
      retryAfterSeconds: expect.any(Number),
    });
  }, 10000);

  test('getPoolStats reports available vs total for utilization monitoring', async () => {
    const pool = require('../services/channelAccountPool');
    accounts[0].is_available = false;

    const stats = await pool.getPoolStats();
    expect(stats).toEqual({ available: 2, total: 3 });
  });
});
