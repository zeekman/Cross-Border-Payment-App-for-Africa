const db = require('../db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');
const { sendPaymentRequestExpiredEmail } = require('../services/email');

const LOCK_KEY = 'lock:payment_request_cleanup';
const LOCK_TTL_S = 3600;

async function acquireLock() {
  const redis = cache.getClient ? cache.getClient() : null;
  if (!redis) return true; // no Redis — allow single-instance run
  try {
    const result = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_S, 'NX');
    return result === 'OK';
  } catch {
    return true; // Redis error — allow run
  }
}

async function releaseLock() {
  const redis = cache.getClient ? cache.getClient() : null;
  if (!redis) return;
  try {
    await redis.del(LOCK_KEY);
  } catch {}
}

async function run() {
  const acquired = await acquireLock();
  if (!acquired) {
    logger.info('payment_request_cleanup: skipped (another instance holds lock)');
    return;
  }

  const start = Date.now();
  let expiredCount = 0;
  let archivedCount = 0;

  try {
    // Mark expired pending requests
    const expiredResult = await db.query(
      `UPDATE payment_requests
       SET status = 'expired'
       WHERE expires_at < NOW() AND status = 'pending'
       RETURNING id, requester_id, amount, asset`
    );
    expiredCount = expiredResult.rowCount;

    // Notify creators of newly expired requests
    for (const row of expiredResult.rows) {
      try {
        const userResult = await db.query('SELECT email FROM users WHERE id = $1', [row.requester_id]);
        if (userResult.rows[0]?.email) {
          await sendPaymentRequestExpiredEmail(userResult.rows[0].email, row.amount, row.asset);
        }
      } catch (err) {
        logger.warn('Failed to send expiry notification', { requestId: row.id, error: err.message });
      }
    }

    // Archive requests older than 90 days
    const archiveResult = await db.query(
      `WITH moved AS (
         DELETE FROM payment_requests
         WHERE expires_at < NOW() - INTERVAL '90 days'
         RETURNING id, requester_id, requester_wallet, amount, asset, memo, expires_at,
                   claimed, claimed_tx_hash, status, created_at
       )
       INSERT INTO archived_payment_requests
         (id, requester_id, requester_wallet, amount, asset, memo, expires_at,
          claimed, claimed_tx_hash, status, created_at)
       SELECT id, requester_id, requester_wallet, amount, asset, memo, expires_at,
              claimed, claimed_tx_hash, status, created_at
       FROM moved
       RETURNING id`
    );
    archivedCount = archiveResult.rowCount;
  } finally {
    await releaseLock();
  }

  const duration = Date.now() - start;
  logger.info('payment_request_cleanup completed', { expired_count: expiredCount, archived_count: archivedCount, duration_ms: duration });
  return { expired_count: expiredCount, archived_count: archivedCount, duration_ms: duration };
}

module.exports = { run };
