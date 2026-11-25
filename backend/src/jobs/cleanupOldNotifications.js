const db = require('../db');
const logger = require('../utils/logger');

async function cleanupOldNotifications() {
  try {
    const result = await db.query(
      `DELETE FROM notifications
       WHERE created_at < NOW() - INTERVAL '90 days'`
    );
    logger.info('Cleaned up old notifications', { deleted: result.rowCount });
    return result.rowCount;
  } catch (err) {
    logger.error('Failed to cleanup old notifications', { error: err.message });
    throw err;
  }
}

module.exports = { cleanupOldNotifications };