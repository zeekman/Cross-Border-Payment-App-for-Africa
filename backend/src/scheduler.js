const cron = require('node-cron');
const crypto = require('crypto');
const logger = require('./utils/logger');
const db = require('./db');
const { tryAcquireLock, renewLock, releaseLock } = require('./utils/distributedLock');
const {
  jobRunsTotal,
  jobDurationSeconds,
  jobLastSuccessTimestamp,
  jobIntervalSeconds,
  jobItemsProcessedTotal,
} = require('./utils/metrics');
const { processScheduledPayments } = require('./jobs/scheduledPaymentsJob');
const { indexContractEvents } = require('./jobs/contractEventIndexer');
const { checkClaimableBalanceExpiry } = require('./jobs/checkClaimableBalanceExpiry');
const { syncOfferEvents } = require('./jobs/syncOfferEvents');
const { processRetryQueue } = require('./services/webpush');
const { activateScheduledFeeConfigs } = require('./jobs/activateScheduledFeeConfigs');
const { remindScheduledFeeConfigs } = require('./jobs/remindScheduledFeeConfigs');
const { processLoyaltyMintQueue } = require('./jobs/loyaltyMintJob');
const { cleanupOldNotifications } = require('./jobs/cleanupOldNotifications');
const { checkKycDocumentExpiry } = require('./jobs/kycExpiryJob');
const { runKycDocumentRetention } = require('./jobs/kycDocumentRetentionJob');
const { reconcileTransactionConfirmations } = require('./jobs/transactionConfirmationJob');

// Configurable cron expressions — fall back to sensible defaults
const PAYMENTS_CRON             = process.env.CRON_SCHEDULED_PAYMENTS   || '* * * * *';
const INDEXER_CRON              = process.env.CRON_CONTRACT_INDEXER     || '*/2 * * * *';
const EXPIRY_CRON               = process.env.CRON_CLAIMABLE_EXPIRY     || '*/15 * * * *';
const OFFER_SYNC_CRON           = process.env.CRON_OFFER_SYNC           || '*/2 * * * *';
const PUSH_RETRY_CRON           = process.env.CRON_PUSH_RETRY           || '* * * * *';
const KYC_EXPIRY_CRON           = process.env.CRON_KYC_EXPIRY           || '0 0 * * *';
const ANALYTICS_REFRESH_CRON    = process.env.CRON_ANALYTICS_REFRESH    || '0 * * * *';
const LOYALTY_MINT_CRON         = process.env.CRON_LOYALTY_MINT         || '* * * * *';
const FEE_CONFIG_ACTIVATE_CRON  = process.env.CRON_FEE_CONFIG_ACTIVATE  || '* * * * *';
const NOTIFICATION_CLEANUP_CRON = process.env.CRON_NOTIFICATION_CLEANUP || '0 2 * * *';
const FEE_CONFIG_REMINDER_CRON  = process.env.CRON_FEE_CONFIG_REMINDER  || '0 * * * *';
const TX_CONFIRMATION_CRON      = process.env.CRON_TX_CONFIRMATION_RECONCILIATION || '* * * * *';

// BE-221: when Redis is unavailable, jobs only run unlocked if explicitly allowed.
// Defaults to true outside production (single-instance dev), false in production.
function allowUnlockedJobs() {
  if (process.env.ALLOW_UNLOCKED_JOBS !== undefined) return process.env.ALLOW_UNLOCKED_JOBS === 'true';
  return process.env.NODE_ENV !== 'production';
}

// BE-222: in-memory per-job status, surfaced via /health/deep
const jobStatus = new Map();

// Rough interval in seconds from a 5-field cron expression (for staleness checks)
function cronIntervalSeconds(expr) {
  const [min, hour, dom] = expr.trim().split(/\s+/);
  const step = (f) => (f.startsWith('*/') ? parseInt(f.slice(2), 10) : null);
  if (min === '*') return 60;
  if (step(min)) return step(min) * 60;
  if (hour === '*') return 3600;
  if (step(hour)) return step(hour) * 3600;
  if (dom === '*') return 86400;
  return 7 * 86400;
}

/**
 * Wrap a job so that:
 *  - overlapping runs in this process are skipped,
 *  - only one instance across replicas runs each tick (Redis lock `job:<name>`,
 *    renewed while the job runs — BE-221/BE-034),
 *  - outcomes are recorded as Prometheus metrics (BE-222),
 *  - errors are always caught.
 * fn receives ctx: { isLockLost(), itemsProcessed(n) }.
 */
function safeJob(name, fn, { lockTtlMs = 5 * 60 * 1000, cronExpr } = {}) {
const PAYMENTS_CRON       = process.env.CRON_SCHEDULED_PAYMENTS   || '* * * * *';   // every minute
const INDEXER_CRON        = process.env.CRON_CONTRACT_INDEXER      || '*/2 * * * *'; // every 2 minutes
const EXPIRY_CRON         = process.env.CRON_CLAIMABLE_EXPIRY      || '*/15 * * * *'; // every 15 minutes
const OFFER_SYNC_CRON     = process.env.CRON_OFFER_SYNC            || '*/2 * * * *'; // every 2 minutes
const PUSH_RETRY_CRON     = process.env.CRON_PUSH_RETRY            || '* * * * *';   // every 60 seconds

const KYC_EXPIRY_CRON      = process.env.CRON_KYC_EXPIRY            || '0 0 * * *';   // daily at midnight
const KYC_RETENTION_CRON   = process.env.CRON_KYC_RETENTION         || '30 2 * * *';  // daily 02:30
const ANALYTICS_REFRESH_CRON = process.env.CRON_ANALYTICS_REFRESH   || '0 * * * *';   // hourly
const LOYALTY_MINT_CRON    = process.env.CRON_LOYALTY_MINT          || '* * * * *';   // every minute
const FEE_CONFIG_ACTIVATE_CRON = process.env.CRON_FEE_CONFIG_ACTIVATE || '* * * * *'; // every minute
const NOTIFICATION_CLEANUP_CRON = process.env.CRON_NOTIFICATION_CLEANUP || '0 2 * * *'; // daily at 2 AM
const PAYMENT_REQUEST_CLEANUP_CRON = process.env.PAYMENT_REQUEST_CLEANUP_CRON || '0 * * * *'; // hourly
const FEE_CONFIG_REMINDER_CRON = process.env.CRON_FEE_CONFIG_REMINDER || '0 * * * *'; // hourly
const TX_CONFIRMATION_CRON = process.env.CRON_TX_CONFIRMATION_RECONCILIATION || '* * * * *'; // every minute

// Wrap a job so overlapping runs are skipped and errors are always caught
function safeJob(name, fn) {
  let running = false;
  const intervalSeconds = cronExpr ? cronIntervalSeconds(cronExpr) : null;
  if (intervalSeconds) jobIntervalSeconds.set({ job: name }, intervalSeconds);
  jobStatus.set(name, { intervalSeconds, lastRunAt: null, lastStatus: null, lastSuccessAt: null, lastError: null });

  return async () => {
    if (running) {
      logger.debug(`${name}: previous run still in progress, skipping`);
      return;
    }
    running = true;
    const lockKey = `job:${name}`;
    const lockValue = crypto.randomBytes(16).toString('hex');
    const ttlSeconds = Math.max(1, Math.ceil(lockTtlMs / 1000));
    let heartbeat = null;
    let lockLost = false;
    let locked = false;
    const state = jobStatus.get(name);

    try {
      const lock = await tryAcquireLock(lockKey, ttlSeconds, lockValue);
      if (lock === 'held') {
        jobRunsTotal.inc({ job: name, status: 'skipped_locked' });
        logger.debug(`${name}: lock held by another instance, skipping`);
        return;
      }
      if (lock === 'unavailable' && !allowUnlockedJobs()) {
        jobRunsTotal.inc({ job: name, status: 'skipped_no_lock' });
        logger.warn(`${name}: Redis lock unavailable and ALLOW_UNLOCKED_JOBS is not true, skipping`);
        return;
      }
      locked = lock === 'acquired';
      if (locked) {
        heartbeat = setInterval(async () => {
          if (!(await renewLock(lockKey, lockValue, ttlSeconds)) && !lockLost) {
            lockLost = true;
            logger.error(`${name}: job lock lost mid-run`);
          }
        }, Math.max(1000, Math.floor(lockTtlMs / 3)));
        if (typeof heartbeat.unref === 'function') heartbeat.unref();
      }

      const ctx = {
        isLockLost: () => lockLost,
        itemsProcessed: (n = 1) => jobItemsProcessedTotal.inc({ job: name }, n),
      };
      const endTimer = jobDurationSeconds.startTimer({ job: name });
      state.lastRunAt = new Date().toISOString();
      try {
        await fn(ctx);
        jobRunsTotal.inc({ job: name, status: 'success' });
        jobLastSuccessTimestamp.set({ job: name }, Date.now() / 1000);
        state.lastStatus = 'success';
        state.lastSuccessAt = new Date().toISOString();
        state.lastError = null;
      } catch (err) {
        jobRunsTotal.inc({ job: name, status: 'error' });
        state.lastStatus = 'error';
        state.lastError = err.message;
        logger.error(`${name}: unhandled error`, { error: err.message, stack: err.stack });
      } finally {
        endTimer();
      }
    } catch (err) {
      logger.error(`${name}: scheduler wrapper error`, { error: err.message });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (locked) await releaseLock(lockKey, lockValue);
      running = false;
    }
  };
}

/** BE-222: snapshot of job state; a job is stale if no success within 3x its interval. */
function getJobStatuses(now = Date.now()) {
  const jobs = {};
  for (const [name, s] of jobStatus) {
    const ref = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : startedAt;
    const stale = !!s.intervalSeconds && now - ref > 3 * s.intervalSeconds * 1000;
    jobs[name] = { ...s, stale };
  }
  return jobs;
}

let startedAt = Date.now();

function register(name, expr, fn, opts = {}) {
  cron.schedule(expr, safeJob(name, fn, { ...opts, cronExpr: expr }));
  logger.info(`${name} job registered`, { cron: expr });
}
  cron.schedule(PUSH_RETRY_CRON, safeJob('pushRetryQueue', () => processRetryQueue(db)));
  logger.info('Push notification retry job registered', { cron: PUSH_RETRY_CRON });
  cron.schedule(KYC_EXPIRY_CRON, safeJob('kycExpiryJob', checkKycDocumentExpiry));
  logger.info('KYC document expiry job registered', { cron: KYC_EXPIRY_CRON });
  cron.schedule(KYC_RETENTION_CRON, safeJob('kycDocumentRetentionJob', runKycDocumentRetention));
  logger.info('KYC document retention job registered', { cron: KYC_RETENTION_CRON });

function startScheduler() {
  startedAt = Date.now();
  register('scheduledPaymentsJob', PAYMENTS_CRON, processScheduledPayments, { lockTtlMs: 55 * 1000 });
  register('contractEventIndexer', INDEXER_CRON, indexContractEvents);
  register('checkClaimableBalanceExpiry', EXPIRY_CRON, checkClaimableBalanceExpiry);
  register('syncOfferEvents', OFFER_SYNC_CRON, syncOfferEvents);
  register('pushRetryQueue', PUSH_RETRY_CRON, () => processRetryQueue(db), { lockTtlMs: 55 * 1000 });
  register('kycExpiryJob', KYC_EXPIRY_CRON, checkKycDocumentExpiry);
  register('loyaltyMintJob', LOYALTY_MINT_CRON, processLoyaltyMintQueue, { lockTtlMs: 55 * 1000 });

  const { refreshDailyAggregates } = require('./services/analyticsRefresh');
  register('analyticsMatViewRefresh', ANALYTICS_REFRESH_CRON, async () => {
    const refreshedAt = await refreshDailyAggregates();
    logger.info('daily_payment_aggregates materialized view refreshed', { refreshedAt });
  });

  register('activateScheduledFeeConfigs', FEE_CONFIG_ACTIVATE_CRON, activateScheduledFeeConfigs, { lockTtlMs: 55 * 1000 });
  register('remindScheduledFeeConfigs', FEE_CONFIG_REMINDER_CRON, remindScheduledFeeConfigs);
  register('cleanupOldNotifications', NOTIFICATION_CLEANUP_CRON, cleanupOldNotifications);
  register('transactionConfirmationReconciliation', TX_CONFIRMATION_CRON, reconcileTransactionConfirmations, { lockTtlMs: 55 * 1000 });
}

function stopScheduler() {
  for (const task of cron.getTasks().values()) task.stop();
}

module.exports = { startScheduler, stopScheduler, safeJob, getJobStatuses, cronIntervalSeconds };
