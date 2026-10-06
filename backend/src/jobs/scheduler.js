/**
 * NOTE (BE-025 audit): this module is NOT required/started anywhere in the
 * app — index.js calls startScheduler() from backend/src/scheduler.js
 * (one directory up), which registers the claimable-balance-expiry and
 * scheduled-payments jobs itself under different cron schedules and does
 * not reference this file. This file (and its exported startScheduler) is
 * currently dead code; the payment-request-cleanup job it registers does
 * not run in production. Kept/documented rather than deleted since wiring
 * it up (or folding its cron registrations into backend/src/scheduler.js)
 * is a separate decision outside the scope of the scheduled-payments
 * dedupe this comment accompanies.
 */
const cron = require('node-cron');
const checkClaimableBalanceExpiry = require('./checkClaimableBalanceExpiry');
const { run: runPaymentRequestCleanup } = require('./paymentRequestCleanupJob');
const logger = require('../utils/logger');

const CLEANUP_CRON = process.env.PAYMENT_REQUEST_CLEANUP_CRON || '0 2 * * *';

function startScheduler() {
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running scheduled claimable balance expiry check');
    await checkClaimableBalanceExpiry();
  });

  cron.schedule(CLEANUP_CRON, async () => {
    logger.info('Running payment request cleanup job');
    await runPaymentRequestCleanup().catch((err) =>
      logger.error('payment_request_cleanup error', { error: err.message })
    );
  });

  logger.info('Job scheduler started');
}

module.exports = { startScheduler };
