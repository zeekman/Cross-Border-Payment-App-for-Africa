const Redis = require('ioredis');
const logger = require('./logger');

const BALANCE_TTL = 30; // seconds

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

module.exports = { get, set, del, BALANCE_TTL };
