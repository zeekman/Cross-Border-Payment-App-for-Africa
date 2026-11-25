const Redis = require('ioredis');
const logger = require('./logger');
const { redisUp } = require('./metrics');

/**
 * BE-173: shared Redis connection factory for cache.js and distributedLock.js.
 *
 * The client used to be created with `lazyConnect: true` and
 * `enableOfflineQueue: false`, so the first command after boot or a
 * reconnect was rejected ("Stream isn't writeable"). The offline queue is now
 * enabled with a short connect timeout so commands issued while connecting
 * wait for the connection instead of failing immediately.
 */
let client = null;

function getRedisClient() {
  if (client) return client;
  if (!process.env.REDIS_URL) return null;

  client = new Redis(process.env.REDIS_URL, {
    enableOfflineQueue: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
  });

  client.on('ready', () => redisUp.set(1));
  client.on('end', () => redisUp.set(0));
  client.on('error', (err) => {
    redisUp.set(0);
    logger.warn('Redis error', { error: err.message });
  });

  return client;
}

module.exports = { getRedisClient };
