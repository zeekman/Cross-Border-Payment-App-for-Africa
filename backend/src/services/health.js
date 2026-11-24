const db = require('../db');
const { withTimeout } = require('../utils/withTimeout');
const stellar = require('./stellar');
const { getAnchorHealth } = require('./anchor');
const { getClient: getRedisClient } = require('../utils/cache');
const logger = require('../utils/logger');
const { getRateLimiterStatus } = require('../middleware/rateLimiter');
const ledgerState = require('./ledgerListenerState');

const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';

// Ledger listener liveness (BE-198). ledgerListener.js records proof of life through
// setLastLedgerEvent: on every stream message, and on every poll that finds the stream
// fully caught up with Horizon, so a quiet network does not read as stale.
// Degraded once there has been no proof of life for LEDGER_LISTENER_MAX_STALE_MS
// (default 90 s, so a dead stream is flagged well inside two minutes).
const DEFAULT_LEDGER_LISTENER_MAX_STALE_MS = 90 * 1000;

function ledgerListenerMaxStaleMs() {
  const configured = Number(process.env.LEDGER_LISTENER_MAX_STALE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LEDGER_LISTENER_MAX_STALE_MS;
}

function setLastLedgerEvent(ts, info) {
  ledgerState.setLastLedgerEvent(ts, info);
}

async function checkDatabase() {
  const start = Date.now();
  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return { status: 'healthy', response_time_ms: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', response_time_ms: Date.now() - start, error: err.message };
  }
}

async function checkHorizon() {
  const start = Date.now();
  try {
    const res = await Promise.race([
      fetch(horizonUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    const ok = res.ok || res.status < 500;
    return { status: ok ? 'healthy' : 'unhealthy', response_time_ms: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', response_time_ms: Date.now() - start, error: err.message };
  }
}

async function checkRedis() {
  const start = Date.now();
  const redis = getRedisClient();
  if (!redis) {
    return { status: 'unhealthy', response_time_ms: 0, error: 'Redis not configured' };
  }
  try {
    const result = await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
    ]);
    const ok = result === 'PONG';
    return { status: ok ? 'healthy' : 'unhealthy', response_time_ms: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', response_time_ms: Date.now() - start, error: err.message };
  }
}

function checkLedgerListener() {
  const s = ledgerState.getLedgerListenerState();
  const maxStaleMs = ledgerListenerMaxStaleMs();
  const details = {
    last_ledger_sequence: s.lastLedgerSequence,
    horizon_latest_ledger: s.horizonLatestLedger,
    lag_ledgers: s.lagLedgers,
  };

  if (!s.lastEventAt) {
    // Never heard from it. Unknown until it has had a fair chance to start, but a
    // listener that was started and stays silent past the threshold is not fine.
    if (s.startedAt && Date.now() - s.startedAt > maxStaleMs) {
      return { status: 'degraded', last_event_at: null, stale_ms: Date.now() - s.startedAt, ...details };
    }
    return { status: 'unknown', last_event_at: null, ...details };
  }

  const staleMs = Date.now() - s.lastEventAt;
  return {
    status: staleMs <= maxStaleMs ? 'healthy' : 'degraded',
    last_event_at: new Date(s.lastEventAt).toISOString(),
    stale_ms: staleMs,
    ...details,
  };
}

// Reports whether each rate limiter is on its shared Redis store or has
// fallen back to per-process in-memory limiting (see issue #952 / BE-005).
function checkRateLimiter() {
  const backends = getRateLimiterStatus();
  const degraded = Object.values(backends).some((backend) => backend !== 'redis');
  return { status: degraded ? 'degraded' : 'healthy', backends };
}

async function checkShallowDatabase() {
  try {
    await withTimeout(db.query('SELECT 1'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Shallow health check for Kubernetes liveness probe.
 */
async function runHealthChecks() {
  const [dbOk, stellarOk] = await Promise.all([
    checkShallowDatabase(),
    stellar.checkHorizonHealth(),
  ]);

  const ok = dbOk && stellarOk;
  const poolStats = db.getPoolStats();
  const anchor = getAnchorHealth();

  return {
    status: ok ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'down',
    stellar: stellarOk ? 'ok' : 'down',
    network: process.env.STELLAR_NETWORK || 'testnet',
    pool: {
      total: poolStats.total,
      idle: poolStats.idle,
      waiting: poolStats.waiting,
    },
    anchor: {
      status: anchor.circuitOpen ? 'down' : 'ok',
      consecutiveFailures: anchor.consecutiveFailures,
    },
  };
}

/**
 * Deep health check for readiness probes and monitoring systems.
 * Returns { status, components, timestamp, version }.
 * HTTP 503 if DB or Redis is unhealthy.
 */
async function runDeepHealthChecks() {
  const [database, horizon, redis] = await Promise.all([
    checkDatabase(),
    checkHorizon(),
    checkRedis(),
  ]);
  const ledger_listener = checkLedgerListener();
  const rate_limiter = checkRateLimiter();

  // BE-036: surface which Horizon endpoint (primary/fallback) is currently
  // active and how long the current fallback activation has lasted, so
  // operators can see it directly in the deep health check output.
  const horizonEndpoint = stellar.getHorizonEndpointStatus();
  horizon.endpoint = horizonEndpoint;

  const criticalFailed = database.status === 'unhealthy' || redis.status === 'unhealthy';
  const nonCriticalFailed =
    horizon.status === 'unhealthy' ||
    ledger_listener.status === 'degraded' ||
    rate_limiter.status === 'degraded' ||
    horizonEndpoint.alertExceeded;

  let status;
  if (criticalFailed) status = 'unhealthy';
  else if (nonCriticalFailed) status = 'degraded';
  else status = 'healthy';

  return {
    status,
    components: { database, horizon, redis, ledger_listener, rate_limiter },
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  };
}

module.exports = { runHealthChecks, runDeepHealthChecks, setLastLedgerEvent, checkLedgerListener };
