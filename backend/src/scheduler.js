const cron = require('node-cron');
const logger = require('./utils/logger');
const { processScheduledPayments } = require('./jobs/scheduledPaymentsJob');
const { indexContractEvents } = require('./jobs/contractEventIndexer');
const { checkClaimableBalanceExpiry } = require('./jobs/checkClaimableBalanceExpiry');
const { syncOfferEvents } = require('./jobs/syncOfferEvents');
const { processRetryQueue } = require('./services/webpush');
const db = require('./db');
const { activateScheduledFeeConfigs } = require('./jobs/activateScheduledFeeConfigs');
const { remindScheduledFeeConfigs } = require('./jobs/remindScheduledFeeConfigs');
const { processLoyaltyMintQueue } = require('./jobs/loyaltyMintJob');
const { cleanupOldNotifications } = require('./jobs/cleanupOldNotifications');
const { checkKycDocumentExpiry } = require('./jobs/kycExpiryJob');

// Configurable cron expressions — fall back to sensible defaults
const PAYMENTS_CRON       = process.env.CRON_SCHEDULED_PAYMENTS   || '* * * * *';   // every minute
const INDEXER_CRON        = process.env.CRON_CONTRACT_INDEXER      || '*/2 * * * *'; // every 2 minutes
const EXPIRY_CRON         = process.env.CRON_CLAIMABLE_EXPIRY      || '*/15 * * * *'; // every 15 minutes
const OFFER_SYNC_CRON     = process.env.CRON_OFFER_SYNC            || '*/2 * * * *'; // every 2 minutes
const PUSH_RETRY_CRON     = process.env.CRON_PUSH_RETRY            || '* * * * *';   // every 60 seconds

const KYC_EXPIRY_CRON      = process.env.CRON_KYC_EXPIRY            || '0 0 * * *';   // daily at midnight
const ANALYTICS_REFRESH_CRON = process.env.CRON_ANALYTICS_REFRESH   || '0 * * * *';   // hourly
const LOYALTY_MINT_CRON    = process.env.CRON_LOYALTY_MINT          || '* * * * *';   // every minute
const FEE_CONFIG_ACTIVATE_CRON = process.env.CRON_FEE_CONFIG_ACTIVATE || '* * * * *'; // every minute
const NOTIFICATION_CLEANUP_CRON = process.env.CRON_NOTIFICATION_CLEANUP || '0 2 * * *'; // daily at 2 AM
const FEE_CONFIG_REMINDER_CRON = process.env.CRON_FEE_CONFIG_REMINDER || '0 * * * *'; // hourly

// Wrap a job so overlapping runs are skipped and errors are always caught
function safeJob(name, fn) {
  let running = false;
  return async () => {
    if (running) {
      logger.debug(`${name}: previous run still in progress, skipping`);
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error(`${name}: unhandled error`, { error: err.message, stack: err.stack });
    } finally {
      running = false;
    }
  };
}

function startScheduler() {
  cron.schedule(PAYMENTS_CRON, safeJob('scheduledPaymentsJob', processScheduledPayments));
  logger.info('Scheduled payments job registered', { cron: PAYMENTS_CRON });

  cron.schedule(INDEXER_CRON, safeJob('contractEventIndexer', indexContractEvents));
  logger.info('Contract event indexer job registered', { cron: INDEXER_CRON });

  cron.schedule(EXPIRY_CRON, safeJob('checkClaimableBalanceExpiry', checkClaimableBalanceExpiry));
  logger.info('Claimable balance expiry job registered', { cron: EXPIRY_CRON });

  cron.schedule(OFFER_SYNC_CRON, safeJob('syncOfferEvents', syncOfferEvents));
  logger.info('DEX offer event sync job registered', { cron: OFFER_SYNC_CRON });

  cron.schedule(PUSH_RETRY_CRON, safeJob('pushRetryQueue', () => processRetryQueue(db)));
  logger.info('Push notification retry job registered', { cron: PUSH_RETRY_CRON });
  cron.schedule(KYC_EXPIRY_CRON, safeJob('kycExpiryJob', checkKycDocumentExpiry));
  logger.info('KYC document expiry job registered', { cron: KYC_EXPIRY_CRON });

  cron.schedule(LOYALTY_MINT_CRON, safeJob('loyaltyMintJob', processLoyaltyMintQueue));
  logger.info('Loyalty mint queue job registered', { cron: LOYALTY_MINT_CRON });

  const { refreshDailyAggregates } = require('./services/analyticsRefresh');
  cron.schedule(ANALYTICS_REFRESH_CRON, safeJob('analyticsMatViewRefresh', async () => {
    const refreshedAt = await refreshDailyAggregates();
    logger.info('daily_payment_aggregates materialized view refreshed', { refreshedAt });
  }));
  logger.info('Analytics materialized view refresh job registered', { cron: ANALYTICS_REFRESH_CRON });

  cron.schedule(FEE_CONFIG_ACTIVATE_CRON, safeJob('activateScheduledFeeConfigs', activateScheduledFeeConfigs));
  logger.info('Fee config activation job registered', { cron: FEE_CONFIG_ACTIVATE_CRON });

  cron.schedule(FEE_CONFIG_REMINDER_CRON, safeJob('remindScheduledFeeConfigs', remindScheduledFeeConfigs));
  logger.info('Fee config activation reminder job registered', { cron: FEE_CONFIG_REMINDER_CRON });

  cron.schedule(NOTIFICATION_CLEANUP_CRON, safeJob('cleanupOldNotifications', cleanupOldNotifications));
  logger.info('Notification cleanup job registered', { cron: NOTIFICATION_CLEANUP_CRON });
}

function stopScheduler() {
  for (const task of cron.getTasks().values()) task.stop();
}

module.exports = { startScheduler, stopScheduler };
