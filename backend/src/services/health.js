const db = require('../db');
const { withTimeout } = require('../utils/withTimeout');
const stellar = require('./stellar');
const { getAnchorHealth } = require('./anchor');
const { getClient: getRedisClient } = require('../utils/cache');
const logger = require('../utils/logger');
const { getRateLimiterStatus } = require('../middleware/rateLimiter');
const ledgerState = require('./ledgerListenerState');

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

const DB_TIMEOUT_MS = 2000;
const HORIZON_TIMEOUT_MS = 3000;
const REDIS_TIMEOUT_MS = 1000;

// BE-199: withTimeout clears its timer as soon as the check settles, so
// frequent probes (liveness every 10 s, /health/deep from Grafana) no longer
// pile up pending timers the way the old bare Promise.race did.
async function checkDatabase() {
  const start = Date.now();
  try {
    await withTimeout(db.query('SELECT 1'), DB_TIMEOUT_MS);
    return { status: 'healthy', response_time_ms: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', response_time_ms: Date.now() - start, error: err.message };
  }
}

/**
 * Report an endpoint by origin only: paid Horizon providers often put the API
 * key in the path or query, and /health/deep is not behind auth.
 */
function horizonLabel(url) {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-url';
  }
}

/**
 * Probe one Horizon endpoint (BE-199).
 *  - 2xx          → healthy
 *  - 429          → degraded, rate_limited: true (calls are being throttled)
 *  - anything else → unhealthy; a 401/403 means the provider key was revoked,
 *    so every real Horizon call is failing even though the server answered.
 * The fetch itself is aborted on timeout so slow sockets are not left open.
 */
async function checkHorizonEndpoint(url) {
  const start = Date.now();
  const base = { url: horizonLabel(url) };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS) });
    const response_time_ms = Date.now() - start;
    if (res.ok) return { ...base, status: 'healthy', http_status: res.status, response_time_ms };
    if (res.status === 429) {
      return { ...base, status: 'degraded', rate_limited: true, http_status: res.status, response_time_ms };
    }
    return { ...base, status: 'unhealthy', http_status: res.status, response_time_ms };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ...base,
      status: 'unhealthy',
      response_time_ms: Date.now() - start,
      error: timedOut ? 'timeout' : err.message,
    };
  }
}

function configuredHorizonEndpoints() {
  if (typeof stellar.getHorizonEndpoints === 'function') return stellar.getHorizonEndpoints();
  return {
    primary: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    fallbacks: process.env.STELLAR_HORIZON_FALLBACK_URL ? [process.env.STELLAR_HORIZON_FALLBACK_URL] : [],
  };
}

/**
 * Check every configured Horizon endpoint and report which one the app is
 * actually using (BE-036 / BE-199):
 *   { status, primary, fallbacks: [...], active, endpoint }
 * Overall status is that of the active endpoint, downgraded to 'degraded' if
 * any other configured endpoint is unhealthy, so running entirely on the
 * fallback is visible.
 */
async function checkHorizon() {
  const { primary: primaryUrl, fallbacks: fallbackUrls } = configuredHorizonEndpoints();
  const [primary, ...fallbacks] = await Promise.all(
    [primaryUrl, ...fallbackUrls].map((url) => checkHorizonEndpoint(url))
  );

  const endpoint = typeof stellar.getHorizonEndpointStatus === 'function'
    ? stellar.getHorizonEndpointStatus()
    : { node: 'primary' };
  const onFallback = endpoint.node === 'fallback' && fallbacks.length > 0;
  const activeCheck = onFallback ? fallbacks[0] : primary;

  let status = activeCheck.status;
  if (status === 'healthy' && [primary, ...fallbacks].some((c) => c.status !== 'healthy')) {
    status = 'degraded';
  }

  const result = {
    status,
    primary,
    fallbacks,
    active: activeCheck.url,
    active_node: onFallback ? 'fallback' : 'primary',
    endpoint,
    response_time_ms: activeCheck.response_time_ms,
  };
  if ([primary, ...fallbacks].some((c) => c.rate_limited)) result.rate_limited = true;
  return result;
}

async function checkRedis() {
  const start = Date.now();
  const redis = getRedisClient();
  if (!redis) {
    return { status: 'unhealthy', response_time_ms: 0, error: 'Redis not configured' };
  }
  try {
    const result = await withTimeout(redis.ping(), REDIS_TIMEOUT_MS);
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

  // BE-222: per-job last run/status; any stale job marks the system degraded
  let jobs = {};
  try {
    jobs = require('../scheduler').getJobStatuses();
  } catch {
    jobs = {};
  }
  const staleJobs = Object.keys(jobs).filter((name) => jobs[name].stale);

  // BE-036: surface which Horizon endpoint (primary/fallback) is currently
  // active and how long the current fallback activation has lasted, so
  // operators can see it directly in the deep health check output.
  const horizonEndpoint = stellar.getHorizonEndpointStatus();
  horizon.endpoint = horizonEndpoint;
  // BE-036: checkHorizon() includes which Horizon endpoint (primary/fallback)
  // is active and how long the current fallback activation has lasted.
  const horizonEndpoint = horizon.endpoint || {};

  const criticalFailed = database.status === 'unhealthy' || redis.status === 'unhealthy';
  const nonCriticalFailed =
    horizon.status !== 'healthy' ||
    ledger_listener.status === 'degraded' ||
    rate_limiter.status === 'degraded' ||
    horizonEndpoint.alertExceeded ||
    staleJobs.length > 0;

  let status;
  if (criticalFailed) status = 'unhealthy';
  else if (nonCriticalFailed) status = 'degraded';
  else status = 'healthy';

  return {
    status,
    components: {
      database,
      horizon,
      redis,
      ledger_listener,
      rate_limiter,
      jobs: { status: staleJobs.length ? 'degraded' : 'healthy', stale: staleJobs, details: jobs },
    },
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  };
}

module.exports = {
  runHealthChecks,
  runDeepHealthChecks,
  setLastLedgerEvent,
  checkLedgerListener,
  checkDatabase,
  checkHorizon,
  checkHorizonEndpoint,
  checkRedis,
};
