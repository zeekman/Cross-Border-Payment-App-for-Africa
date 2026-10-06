const Redis = require('ioredis');
const logger = require('./logger');

// Read balance cache TTL from environment, default to 30 seconds
const BALANCE_TTL = parseInt(process.env.BALANCE_CACHE_TTL_SECONDS || '30', 10);

let client = null;

function getClient() {
  if (client) return client;

  if (!process.env.REDIS_URL) {
    return null; // Redis not configured — fall back to live calls
  }

  client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  client.on('error', (err) => {
    logger.warn('Redis error — falling back to live calls', { error: err.message });
  });

  return client;
}

async function get(key) {
  const redis = getClient();
  if (!redis) return null;
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
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('Redis SET failed', { key, error: err.message });
  }
}

async function del(key) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn('Redis DEL failed', { key, error: err.message });
  }
}

// Delete every key matching a glob pattern (e.g. 'balance:*'). Used to invalidate
// a whole family of cached entries at once — see delPattern's callers for the
// documented cache-invalidation paths that rely on it (e.g. asset toggling).
async function delPattern(pattern) {
  const redis = getClient();
  if (!redis) return;
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

module.exports = { get, set, del, delPattern, getClient, BALANCE_TTL };
