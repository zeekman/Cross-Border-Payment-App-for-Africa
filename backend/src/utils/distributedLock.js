const crypto = require('crypto');
const Redis = require('ioredis');

let client = null;
function getClient() {
  if (client || !process.env.REDIS_URL) return client;
  client = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  client.on('error', () => {});
  return client;
}

/**
 * Run `fn` only if this process acquires `key` (SET NX PX). Returns
 * { acquired: false } when another replica holds the lock. Without Redis
 * (single-process dev) the lock always succeeds.
 */
async function withLock(key, ttlMs, fn) {
  const redis = getClient();
  const token = crypto.randomUUID();
  if (redis) {
    const ok = await redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX').catch(() => null);
    if (ok !== 'OK') return { acquired: false };
  }
  try {
    return { acquired: true, result: await fn() };
  } catch (err) {
    if (redis) {
      // release early on failure so another replica may retry
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
        1, `lock:${key}`, token,
      ).catch(() => {});
    }
    throw err;
  }
}

module.exports = { withLock };
