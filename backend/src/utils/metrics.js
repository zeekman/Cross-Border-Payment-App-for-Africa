const client = require('prom-client');

const registry = new client.Registry();

// Default Node.js process metrics (memory, CPU, event loop lag, etc.)
client.collectDefaultMetrics({ register: registry });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

const horizonRequestDuration = new client.Histogram({
  name: 'horizon_request_duration_seconds',
  help: 'Stellar Horizon API call duration in seconds',
  labelNames: ['operation', 'success'],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'PostgreSQL query duration in seconds',
  labelNames: ['success'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [registry],
});

const wsConnections = new client.Gauge({
  name: 'websocket_active_connections',
  help: 'Number of active Horizon WebSocket stream connections',
  registers: [registry],
});

const anchorPollDuration = new client.Histogram({
  name: 'anchor_poll_duration_seconds',
  help: 'Anchor transaction-status poll duration in seconds, per anchor',
  labelNames: ['anchor', 'success'],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

const paymentsTotal = new client.Counter({
  name: 'afripay_payments_total',
  help: 'Total payment state changes',
  labelNames: ['status', 'asset'],
  registers: [registry],
});

const paymentAmountUsdc = new client.Histogram({
  name: 'afripay_payment_amount_usdc',
  help: 'Distribution of payment amounts in USDC',
  buckets: [1, 5, 10, 50, 100, 500, 1000, 5000, 10000],
  registers: [registry],
});

const afripayHorizonDuration = new client.Histogram({
  name: 'afripay_horizon_request_duration_ms',
  help: 'Horizon API call latency in milliseconds',
  labelNames: ['endpoint'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

const activeUsers = new client.Gauge({
  name: 'afripay_active_users',
  help: 'Users with sessions active in last 5 minutes',
  registers: [registry],
});

const emailQueueDepth = new client.Gauge({
  name: 'afripay_email_queue_depth',
  help: 'Email queue waiting job count',
  registers: [registry],
});

const amlScreeningsTotal = new client.Counter({
  name: 'afripay_aml_screenings_total',
  help: 'Total AML screening decisions, labelled by outcome (clear, flagged, error, not_screened)',
  labelNames: ['status'],
  registers: [registry],
});

const amlScreeningCoverageGauge = new client.Gauge({
  name: 'afripay_aml_screening_coverage_ratio',
  help: 'Ratio of AML screening attempts performed by a real provider vs total attempts (provider screens + passthrough)',
  registers: [registry],
});

const rateLimiterDegraded = new client.Gauge({
  name: 'afripay_rate_limiter_degraded',
  help: 'Whether a rate limiter has fallen back to per-process in-memory limiting (1) or is using shared Redis (0), labelled by limiter prefix',
  labelNames: ['prefix'],
  registers: [registry],
});

const rateLimiterRedisFailuresTotal = new client.Counter({
  name: 'afripay_rate_limiter_redis_failures_total',
  help: 'Total times the rate limiter Redis store was unavailable, labelled by prefix and reason',
  labelNames: ['prefix', 'reason'],
  registers: [registry],
});

// BE-034: distributed lock heartbeat/renewal metrics
const distributedLockRenewalFailuresTotal = new client.Counter({
  name: 'afripay_distributed_lock_renewal_failures_total',
  help: 'Total times a distributed lock heartbeat renewal failed or lost ownership, labelled by lock key',
  labelNames: ['lock_key'],
  registers: [registry],
});

const distributedLockLostTotal = new client.Counter({
  name: 'afripay_distributed_lock_lost_total',
  help: 'Total times a long-running job detected it lost its distributed lock mid-run, labelled by lock key',
  labelNames: ['lock_key'],
  registers: [registry],
});

// BE-036: Horizon fallback duration metrics
const horizonFallbackActive = new client.Gauge({
  name: 'afripay_horizon_fallback_active',
  help: 'Whether the backend is currently serving Horizon requests from the fallback node (1) or primary (0)',
  registers: [registry],
});

const horizonFallbackDurationSeconds = new client.Gauge({
  name: 'afripay_horizon_fallback_duration_seconds',
  help: 'How long (seconds) the current fallback activation has been continuously active; 0 when on primary',
  registers: [registry],
});

const horizonFallbackAlertsTotal = new client.Counter({
  name: 'afripay_horizon_fallback_alerts_total',
  help: 'Total times an alert was raised for Horizon fallback exceeding the configured duration threshold',
  registers: [registry],
});

// BE-037: geo-restriction denial metrics
const geoDenialsTotal = new client.Counter({
  name: 'afripay_geo_denials_total',
  help: 'Total requests denied by geo-restriction, labelled by country and route',
  labelNames: ['country', 'route'],
  registers: [registry],
});

const txQueueDepth = new client.Gauge({
  name: 'afripay_tx_queue_depth',
  help: 'Number of per-wallet transaction submission queues currently holding a pending/in-flight task (txQueue.js)',
  registers: [registry],
});

const txQueueBackpressure = new client.Gauge({
  name: 'afripay_tx_queue_backpressure',
  help: 'Whether the transaction submission queue is under backpressure — total pending tasks across all wallet queues exceeds the configured threshold (1) or not (0)',
  registers: [registry],
});

const txQueuePendingTasksTotal = new client.Gauge({
  name: 'afripay_tx_queue_pending_tasks_total',
  help: 'Total pending/in-flight tasks across all per-wallet transaction submission queues (txQueue.js)',
  registers: [registry],
});

const sep31CallbackSkippedTotal = new client.Counter({
  name: 'afripay_sep31_callback_skipped_total',
  help: 'Total SEP-31 callbacks skipped instead of being delivered, labelled by reason',
  labelNames: ['reason'],
  registers: [registry],
});

module.exports = {
  registry,
  httpRequestDuration,
  horizonRequestDuration,
  dbQueryDuration,
  wsConnections,
  anchorPollDuration,
  paymentsTotal,
  paymentAmountUsdc,
  afripayHorizonDuration,
  activeUsers,
  emailQueueDepth,
  amlScreeningsTotal,
  amlScreeningCoverageGauge,
  rateLimiterDegraded,
  rateLimiterRedisFailuresTotal,
  distributedLockRenewalFailuresTotal,
  distributedLockLostTotal,
  horizonFallbackActive,
  horizonFallbackDurationSeconds,
  horizonFallbackAlertsTotal,
  geoDenialsTotal,
  txQueueDepth,
  txQueueBackpressure,
  txQueuePendingTasksTotal,
  sep31CallbackSkippedTotal,
};
