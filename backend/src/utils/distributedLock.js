const Redis = require('ioredis');
const crypto = require('crypto');
const logger = require('./logger');
const { distributedLockRenewalFailuresTotal, distributedLockLostTotal } = require('./metrics');

let client = null;

function getClient() {
  if (client) return client;
  if (!process.env.REDIS_URL) return null;

  client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  client.on('error', (err) => {
    logger.warn('Redis error in distributed lock', { error: err.message });
  });

  return client;
}

// Lua script: only delete the key if the value matches (atomic check-and-delete)
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

// Lua script: only extend the TTL if we still own the lock (atomic check-and-expire)
const RENEW_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("expire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

async function acquireLock(lockKey, ttlSeconds, lockValue) {
  const redis = getClient();
  if (!redis) return true; // single-instance mode: no lock needed
  try {
    const result = await redis.set(lockKey, lockValue, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.warn('Failed to acquire distributed lock', { lockKey, error: err.message });
    return false;
  }
}

async function releaseLock(lockKey, lockValue) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.eval(RELEASE_SCRIPT, 1, lockKey, lockValue);
  } catch (err) {
    logger.warn('Failed to release distributed lock', { lockKey, error: err.message });
  }
}

/**
 * Atomically extend the TTL of a lock we believe we hold.
 * Returns true if renewal succeeded (we still owned the lock), false otherwise
 * (lock expired, was stolen, or Redis is unavailable).
 */
async function renewLock(lockKey, lockValue, ttlSeconds) {
  const redis = getClient();
  if (!redis) return true; // single-instance mode: nothing to renew
  try {
    const result = await redis.eval(RENEW_SCRIPT, 1, lockKey, lockValue, ttlSeconds);
    return result === 1;
  } catch (err) {
    logger.warn('Failed to renew distributed lock', { lockKey, error: err.message });
    return false;
  }
}

/**
 * BE-034: Heartbeat/renewal for long-running lock holders.
 *
 * A fixed-TTL lock silently expires if the job it protects runs longer than
 * the TTL, allowing a second concurrent invocation to start. To prevent
 * this, `withLock` starts a background heartbeat timer that re-extends the
 * lock's TTL at TTL/3 intervals for as long as `fn` is running. If a
 * renewal ever fails (lock lost/stolen, Redis unreachable), the heartbeat
 * stops and flags lock loss via `getLockLostFlag()` / a metric + log so the
 * caller can detect it and abort safely rather than continuing unaware.
 *
 * @param {string} lockKey
 * @param {number} ttlSeconds - initial TTL and the value each renewal re-applies
 * @param {(ctx: { isLockLost: () => boolean }) => Promise<any>} fn
 * @returns {Promise<boolean>} true if the lock was acquired and fn ran
 */
async function withLock(lockKey, ttlSeconds, fn) {
  const lockValue = crypto.randomBytes(16).toString('hex');
  const acquired = await acquireLock(lockKey, ttlSeconds, lockValue);
  if (!acquired) return false;

  let lockLost = false;
  const isLockLost = () => lockLost;

  // Heartbeat: renew at 1/3 of the TTL (min 1s) so at least two renewal
  // attempts happen before the original lock would have expired.
  const heartbeatIntervalMs = Math.max(1000, Math.floor((ttlSeconds * 1000) / 3));
  let heartbeat = null;

  if (getClient()) {
    heartbeat = setInterval(async () => {
      const renewed = await renewLock(lockKey, lockValue, ttlSeconds);
      if (!renewed && !lockLost) {
        lockLost = true;
        distributedLockLostTotal.inc({ lock_key: lockKey });
        distributedLockRenewalFailuresTotal.inc({ lock_key: lockKey });
        logger.error('Distributed lock renewal failed - lock lost mid-run, job should abort safely', {
          lockKey,
        });
      }
      if (heartbeat) clearInterval(heartbeat);
    }, heartbeatIntervalMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  }

  try {
    await fn({ isLockLost });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await releaseLock(lockKey, lockValue);
  }
  return true;
}

module.exports = { acquireLock, releaseLock, renewLock, withLock };
