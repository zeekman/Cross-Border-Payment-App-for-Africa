'use strict';

/**
 * Durable webhook delivery (BE-217).
 *
 * Deliveries used to be retried with in-process timers: three attempts over about
 * three seconds, lost on any restart, with decrypted secrets held in the retry
 * closures. Now each (event, subscriber) is one BullMQ job:
 *
 *  - Retries follow a configurable backoff schedule (default 8 retries over ~2 days)
 *    and survive an API restart because the jobs live in Redis.
 *  - The job payload carries only the webhook id and the event payload. The worker
 *    loads the webhook and its secret from the database at send time.
 *  - When an event exhausts every retry the delivery is marked failed, the owner is
 *    notified, and after WEBHOOK_MAX_CONSECUTIVE_FAILURES failed events in a row the
 *    endpoint is disabled automatically.
 *  - Queue depth is exported as `afripay_webhook_queue_depth{state}`.
 *
 * Without REDIS_URL the queue is disabled and webhook.js falls back to its legacy
 * in-process retries (see deliverWithRetry), exactly like the email queue.
 */

const db = require('../db');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const webhook = require('./webhook');

const QUEUE_NAME = 'webhook-delivery';
/** WEBHOOK_QUEUE_NAME overrides the name, e.g. to isolate integration tests or environments sharing one Redis. */
const queueName = () => process.env.WEBHOOK_QUEUE_NAME || QUEUE_NAME;

/** Delay before each retry. 8 retries after the first attempt, about 45 hours in total. */
const DEFAULT_BACKOFF_SCHEDULE = '10s,1m,5m,30m,2h,6h,12h,24h';
const MAX_SCHEDULE_LENGTH = 20;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_WORKER_CONCURRENCY = 5;
const DEPTH_SAMPLE_MS = 15_000;

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

let queue = null;
let worker = null;
let depthTimer = null;
let activeConfig = null;

/** "30s", "5m", "2h" or "1d" to milliseconds, or null if the token is not a duration. */
function parseDuration(token) {
  const match = /^(\d+)(s|m|h|d)$/i.exec(String(token).trim());
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
  return ms > 0 ? ms : null;
}

/**
 * Parse WEBHOOK_RETRY_SCHEDULE: comma-separated delays, each a number plus a unit
 * (s, m, h, d), e.g. "10s,1m,5m,30m,2h". Anything malformed (a bad token, an empty
 * list, more than MAX_SCHEDULE_LENGTH entries) falls back to the default schedule
 * rather than silently shortening the retry window.
 */
function parseBackoffSchedule(raw) {
  const defaults = DEFAULT_BACKOFF_SCHEDULE.split(',').map(parseDuration);
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaults;

  const parsed = String(raw).split(',').map(parseDuration);
  if (parsed.length > MAX_SCHEDULE_LENGTH || parsed.some((ms) => ms === null)) {
    logger.warn('Invalid WEBHOOK_RETRY_SCHEDULE, using the default schedule', { value: raw });
    return defaults;
  }
  return parsed;
}

const positiveInt = (raw, fallback) => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Resolve the delivery settings from the environment.
 *
 *   WEBHOOK_RETRY_SCHEDULE            delays between attempts, e.g. "10s,1m,5m,30m,2h,6h,12h,24h"
 *   WEBHOOK_MAX_CONSECUTIVE_FAILURES  failed events in a row before the endpoint is disabled (5)
 *   WEBHOOK_WORKER_CONCURRENCY        deliveries sent in parallel (5)
 *
 * `attempts` is the first try plus one retry per schedule entry.
 */
function getWebhookConfig(env = process.env) {
  const backoffMs = parseBackoffSchedule(env.WEBHOOK_RETRY_SCHEDULE);
  return {
    backoffMs,
    attempts: backoffMs.length + 1,
    maxConsecutiveFailures: positiveInt(env.WEBHOOK_MAX_CONSECUTIVE_FAILURES, DEFAULT_MAX_CONSECUTIVE_FAILURES),
    concurrency: positiveInt(env.WEBHOOK_WORKER_CONCURRENCY, DEFAULT_WORKER_CONCURRENCY),
  };
}

/** Delay before the retry that follows attempt number `attemptsMade` (1-based). */
function backoffDelayMs(attemptsMade, backoffMs) {
  return backoffMs[Math.min(Math.max(attemptsMade, 1), backoffMs.length) - 1];
}

const count = (result) => metrics.webhookDeliveriesTotal?.inc({ result });

/** Host only, for messages: the full URL may carry a token in its path or query. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'your endpoint';
  }
}

async function resetConsecutiveFailures(webhookId) {
  await db
    .query(`UPDATE webhooks SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0`, [webhookId])
    .catch((err) => logger.warn('Failed to reset webhook failure streak', { webhookId, error: err.message }));
}

/**
 * Worker handler: one delivery attempt for one (event, subscriber) job.
 * Throws on failure so BullMQ schedules the next retry from the backoff schedule.
 */
async function processWebhookJob(job) {
  const { webhookId, payload } = job.data;
  const attempt = (job.attemptsMade || 0) + 1;
  const maxAttempts = job.opts?.attempts || 1;

  // Secrets are loaded here, at send time, and never travel through the queue.
  const { rows } = await db.query(
    `SELECT id, user_id, url, secret, previous_secret, previous_secret_expires_at, active
     FROM webhooks WHERE id = $1`,
    [webhookId]
  );
  const row = rows[0];
  if (!row || !row.active) {
    // Deleted or disabled since the event was queued: drop it instead of retrying for days.
    count('skipped');
    logger.info('Webhook delivery skipped: endpoint missing or disabled', { webhookId, jobId: job.id });
    return { skipped: true };
  }

  try {
    const { statusCode } = await webhook.attemptDelivery(row, payload, attempt, maxAttempts);
    await resetConsecutiveFailures(webhookId);
    count('delivered');
    return { statusCode };
  } catch (err) {
    if (err && err.retryable === false) {
      // Retrying cannot help (e.g. the URL now resolves to a private address).
      const { UnrecoverableError } = require('bullmq');
      throw new UnrecoverableError(err.message);
    }
    throw err;
  }
}

async function notifyOwner(userId, type, title, body, data) {
  try {
    const { persistAndBroadcast } = require('./notificationInbox');
    await persistAndBroadcast(userId, type, title, body, data);
  } catch (err) {
    logger.warn('Failed to create webhook notification', { userId, type, error: err.message });
  }
  try {
    const { rows } = await db.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    if (!rows[0]?.email) return;
    const { enqueueEmail, escapeHtml } = require('./email');
    await enqueueEmail({
      to: rows[0].email,
      subject: title,
      html: `<p>${escapeHtml(body)}</p>`,
      text: body,
    });
  } catch (err) {
    logger.warn('Failed to email webhook notification', { userId, type, error: err.message });
  }
}

/** Stop sending to an endpoint that keeps failing, and tell its owner. */
async function disableEndpoint(row, streak, event) {
  const reason = `Disabled after ${streak} consecutive failed events (last event: ${event}).`;
  const { rows } = await db.query(
    `UPDATE webhooks SET active = false, disabled_at = NOW(), disabled_reason = $2
     WHERE id = $1 AND active = true RETURNING id`,
    [row.id, reason]
  );
  if (!rows.length) return false; // someone else disabled it first
  metrics.webhookEndpointsDisabledTotal?.inc();
  logger.warn('Webhook endpoint disabled after repeated failures', { webhookId: row.id, streak });
  await notifyOwner(
    row.user_id,
    'webhook_endpoint_disabled',
    'Webhook endpoint disabled',
    `We disabled your webhook endpoint ${hostOf(row.url)} after ${streak} consecutive failed events. ` +
      `Fix the endpoint, then re-enable it in your webhook settings to resume deliveries.`,
    { webhook_id: row.id, consecutive_failures: streak }
  );
  return true;
}

/**
 * An event exhausted every retry. Record the failure, tell the owner, and disable the
 * endpoint once WEBHOOK_MAX_CONSECUTIVE_FAILURES events in a row have failed.
 */
async function handlePermanentFailure(job, err, config = activeConfig || getWebhookConfig()) {
  const { webhookId, payload } = job.data;
  const event = payload?.event || 'unknown';
  logger.error('Webhook delivery permanently failed', {
    webhookId,
    jobId: job.id,
    event,
    attempts: job.attemptsMade,
    error: err?.message,
  });

  const { rows } = await db.query(
    `UPDATE webhooks SET consecutive_failures = consecutive_failures + 1
     WHERE id = $1 RETURNING id, user_id, url, active, consecutive_failures`,
    [webhookId]
  );
  const row = rows[0];
  if (!row) return; // webhook was deleted meanwhile

  await notifyOwner(
    row.user_id,
    'webhook_delivery_failed',
    'Webhook delivery failed',
    `We could not deliver the "${event}" event to ${hostOf(row.url)} after ${job.attemptsMade} attempts. ` +
      `Last error: ${err?.message || 'unknown'}. You can retry it from your webhook delivery log.`,
    { webhook_id: row.id, event, attempts: job.attemptsMade }
  );

  if (row.active && row.consecutive_failures >= config.maxConsecutiveFailures) {
    await disableEndpoint(row, row.consecutive_failures, event);
  }
}

/** Worker 'failed' event: a retry is scheduled, or the event is out of attempts. */
async function onJobFailed(job, err, config = activeConfig || getWebhookConfig()) {
  if (!job) return;
  const unrecoverable = err?.name === 'UnrecoverableError';
  const exhausted = (job.attemptsMade || 0) >= (job.opts?.attempts || 1);
  if (unrecoverable || exhausted) {
    count('failed');
    await handlePermanentFailure(job, err, config);
    return;
  }
  count('retry');
  logger.warn('Webhook delivery failed, will retry', {
    webhookId: job.data?.webhookId,
    jobId: job.id,
    attempt: job.attemptsMade,
    maxAttempts: job.opts?.attempts,
    error: err?.message,
  });
}

async function sampleQueueDepth() {
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    for (const [state, value] of Object.entries(counts)) {
      metrics.webhookQueueDepth?.set({ state }, value);
    }
  } catch (err) {
    logger.warn('Failed to sample webhook queue depth', { error: err.message });
  }
}

function getRedisConnection() {
  const { Redis } = require('ioredis');
  return new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
}

/** Start the queue and its worker. No-op (returns null) when REDIS_URL is not set. */
function initWebhookQueue() {
  if (queue) return queue;
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set — webhook queue disabled, using in-process retries');
    return null;
  }

  const { Queue, Worker } = require('bullmq');
  activeConfig = getWebhookConfig();
  const config = activeConfig;

  queue = new Queue(queueName(), {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: config.attempts,
      backoff: { type: 'custom' },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  worker = new Worker(queueName(), processWebhookJob, {
    connection: getRedisConnection(),
    concurrency: config.concurrency,
    settings: { backoffStrategy: (attemptsMade) => backoffDelayMs(attemptsMade, config.backoffMs) },
  });
  worker.on('failed', (job, err) => {
    onJobFailed(job, err, config).catch((handlerErr) =>
      logger.error('Webhook failure handler threw', { jobId: job?.id, error: handlerErr.message })
    );
  });
  worker.on('error', (err) => logger.error('Webhook worker error', { error: err.message }));

  void sampleQueueDepth();
  depthTimer = setInterval(() => void sampleQueueDepth(), DEPTH_SAMPLE_MS);
  depthTimer.unref();

  logger.info('Webhook queue initialized', {
    attempts: config.attempts,
    concurrency: config.concurrency,
    maxConsecutiveFailures: config.maxConsecutiveFailures,
  });
  return queue;
}

function isQueueEnabled() {
  return queue !== null;
}

function getWebhookQueue() {
  return queue;
}

/** Add one durable delivery job for (event, subscriber). The job holds no secret. */
async function enqueueDelivery({ webhookId, userId, payload }) {
  if (!queue) throw new Error('Webhook queue is not running');
  return queue.add('deliver', { webhookId, userId, payload });
}

async function drainWebhookQueue() {
  if (depthTimer) {
    clearInterval(depthTimer);
    depthTimer = null;
  }
  if (worker) await worker.close();
  if (queue) await queue.close();
  worker = null;
  queue = null;
  activeConfig = null;
}

module.exports = {
  QUEUE_NAME,
  DEFAULT_BACKOFF_SCHEDULE,
  parseDuration,
  parseBackoffSchedule,
  getWebhookConfig,
  backoffDelayMs,
  processWebhookJob,
  handlePermanentFailure,
  onJobFailed,
  initWebhookQueue,
  isQueueEnabled,
  getWebhookQueue,
  enqueueDelivery,
  drainWebhookQueue,
};
