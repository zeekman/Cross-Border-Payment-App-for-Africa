const { Pool } = require('pg');
const logger = require('./utils/logger');

const WAITING_ALERT_THRESHOLD = 5;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Emitted each time a new physical client is connected to the PostgreSQL server.
pool.on('connect', (client) => {
  logger.debug('DB pool: new client connected', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

// Emitted each time a client is checked out from the pool.
pool.on('acquire', (client) => {
  logger.debug('DB pool: client acquired', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });

  if (pool.waitingCount > WAITING_ALERT_THRESHOLD) {
    logger.error('DB pool: waiting queue exceeded threshold', {
      waitingCount: pool.waitingCount,
      threshold: WAITING_ALERT_THRESHOLD,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
    });
  }
});

// Emitted each time a client is removed from the pool and disconnected.
pool.on('remove', (client) => {
  logger.debug('DB pool: client removed', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

// Emitted whenever an idle client in the pool encounters an error.
pool.on('error', (err) => {
  logger.error('DB pool: unexpected error on idle client', {
    message: err.message,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

/**
 * Returns a snapshot of the current pool health metrics.
 * @returns {{ total: number, idle: number, waiting: number }}
 */
function getPoolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  getPoolStats,
};
