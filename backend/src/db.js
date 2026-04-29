const { Pool } = require('pg');
const { dbQueryDuration } = require('./utils/metrics');
const logger = require('./utils/logger');

const WAITING_ALERT_THRESHOLD = 5;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Maximum number of clients in the pool (default: 20)
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  // How long a client is allowed to remain idle before being closed (default: 30000ms)
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS) || 30000,
  // How long to wait for a connection before timing out (default: 5000ms)
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS) || 5000,
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
 * Executes a SQL query using a client from the pool.
 * @param {string} text - SQL query string
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} - Query result
 */
async function query(text, params) {
  const end = dbQueryDuration.startTimer();
  try {
    const result = await pool.query(text, params);
    end({ success: 'true' });
    return result;
  } catch (err) {
    end({ success: 'false' });
    throw err;
  }
}

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
  query,
  pool,
  getPoolStats,
};
