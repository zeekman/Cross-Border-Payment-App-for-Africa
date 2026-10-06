const db = require('../db');
const logger = require('../utils/logger');
const { findConfigsDueForReminder, markReminderSent } = require('../services/feeConfigService');
const { persistAndBroadcast } = require('../services/notificationInbox');

// How far ahead of activation admins get reminded, configurable via env.
const REMINDER_WINDOW_HOURS = parseInt(process.env.FEE_CONFIG_REMINDER_WINDOW_HOURS, 10) || 24;

/**
 * Notifies all admin users of scheduled fee-config changes that will
 * activate within REMINDER_WINDOW_HOURS, so a change scheduled days or
 * weeks earlier doesn't silently go live unnoticed. Each config is only
 * reminded about once (tracked via fee_configs.reminder_sent_at).
 */
async function remindScheduledFeeConfigs() {
  const dueConfigs = await findConfigsDueForReminder(REMINDER_WINDOW_HOURS);
  if (dueConfigs.length === 0) return;

  const { rows: admins } = await db.query(
    `SELECT id FROM users WHERE role = 'admin'`
  );
  if (admins.length === 0) {
    logger.warn('remindScheduledFeeConfigs: no admin users found to notify');
  }

  for (const config of dueConfigs) {
    const title = 'Scheduled fee change activating soon';
    const body = `Fee config #${config.id} (${config.fee_type}/${config.asset_code}, ${config.fee_bps} bps) ` +
      `activates at ${new Date(config.effective_from).toISOString()}.`;

    for (const admin of admins) {
      try {
        await persistAndBroadcast(admin.id, 'fee_config_reminder', title, body, {
          fee_config_id: config.id,
          fee_type: config.fee_type,
          asset_code: config.asset_code,
          effective_from: config.effective_from,
        });
      } catch (err) {
        logger.warn('remindScheduledFeeConfigs: failed to notify admin', {
          adminId: admin.id,
          feeConfigId: config.id,
          error: err.message,
        });
      }
    }

    await markReminderSent(config.id);
  }
}

module.exports = { remindScheduledFeeConfigs };
