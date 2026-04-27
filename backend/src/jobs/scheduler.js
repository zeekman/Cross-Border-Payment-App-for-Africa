const cron = require('node-cron');
const checkClaimableBalanceExpiry = require('./checkClaimableBalanceExpiry');
const logger = require('../utils/logger');

// Schedule daily check at 9 AM
function startScheduler() {
  // Run daily at 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running scheduled claimable balance expiry check');
    await checkClaimableBalanceExpiry();
  });

  logger.info('Job scheduler started');
}

module.exports = { startScheduler };
