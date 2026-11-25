const logger = require('./logger');
const { getRedisClient } = require('./redisClient');

// Read balance cache TTL from environment, default to 30 seconds
const BALANCE_TTL = parseInt(process.env.BALANCE_CACHE_TTL_SECONDS || '30', 10);

let client = null;
const localOneTimeKeys = new Map();

function getClient() {
  return getRedisClient(); // null when REDIS_URL is not configured
}

// BE-172: in-process fallback used only when REDIS_URL is unset (development;
// production requires REDIS_URL). Keeps token revocation and WebAuthn
// challenges working on a single instance instead of silently doing nothing.
const memory = new Map();

function memGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key, value, ttlSeconds) {
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function memDelPattern(pattern) {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  for (const key of memory.keys()) {
    if (re.test(key)) memory.delete(key);
  }
}

/**
 * BE-172: like get(), but rethrows Redis errors so security-critical callers
 * (token revocation, WebAuthn challenges) can fail closed instead of
 * treating an outage as "key not found".
 */
async function getStrict(key) {
  const redis = getClient();
  if (!redis) return memGet(key);
  const value = await redis.get(key);
  return value ? JSON.parse(value) : null;
}

async function get(key) {
  const redis = getClient();
  if (!redis) return memGet(key);
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    logger.warn('Redis GET failed', { key, error: err.message });
    return null;
  }
}

async function set(key, value, ttlSeconds = BALANCE_TTL) {
  const redis = getClient();
  if (!redis) return memSet(key, value, ttlSeconds);
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('Redis SET failed', { key, error: err.message });
  }
}

async function del(key) {
  const redis = getClient();
  if (!redis) return memory.delete(key);
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn('Redis DEL failed', { key, error: err.message });
  }
}

async function setIfAbsent(key, value, ttlSeconds) {
  const redis = getClient();
  if (!redis) {
    const now = Date.now();
    for (const [storedKey, expiresAt] of localOneTimeKeys) {
      if (expiresAt <= now) localOneTimeKeys.delete(storedKey);
    }
    if (localOneTimeKeys.has(key)) return false;
    localOneTimeKeys.set(key, now + ttlSeconds * 1000);
    return true;
  }

  try {
    const result = await redis.set(key, String(value), 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.warn('Redis SET NX failed', { key, error: err.message });
    return false;
  }
}

// Delete every key matching a glob pattern (e.g. 'balance:*'). Used to invalidate
// a whole family of cached entries at once — see delPattern's callers for the
// documented cache-invalidation paths that rely on it (e.g. asset toggling).
async function delPattern(pattern) {
  const redis = getClient();
  if (!redis) return memDelPattern(pattern);
  try {
    let cursor = '0';
    do {
      // eslint-disable-next-line no-await-in-loop
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length) {
        // eslint-disable-next-line no-await-in-loop
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn('Redis SCAN/DEL pattern failed', { pattern, error: err.message });
  }
}

module.exports = { get, set, del, delPattern, setIfAbsent, getClient, BALANCE_TTL };
