const db = require('../db');
const webhook = require('../services/webhook');
const logger = require('../utils/logger');
const { persistAndBroadcast } = require('../services/notificationInbox');
const { sendClaimableBalanceExpiringEmail } = require('../services/email');

const WARN_HOURS = parseInt(process.env.CLAIMABLE_BALANCE_WARN_HOURS || '24', 10);

async function notifyUser(userId, balanceId, expiresAt) {
  try {
    const { rows } = await db.query('SELECT email, full_name FROM users WHERE id = $1', [userId]);
    if (!rows[0]) return;
    const { email, full_name } = rows[0];
    await sendClaimableBalanceExpiringEmail(email, full_name, balanceId, expiresAt);
    logger.info('Expiry notification sent', { userId, balanceId });
  } catch (err) {
    logger.warn('Failed to send expiry notification email', { userId, balanceId, error: err.message });
  }
}

async function checkClaimableBalanceExpiry(now = new Date()) {
  const { rows: expired } = await db.query(
    `WITH expired_balances AS (
       UPDATE claimable_balances
       SET status = 'expired', updated_at = NOW()
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1
       RETURNING id, balance_id, user_id, asset, amount
     ), expired_transactions AS (
       UPDATE transactions AS tx
      SET status = 'expired', confirmed_at = $1
       FROM expired_balances AS balance
       WHERE tx.claimable_balance_id = balance.balance_id
         AND tx.status = 'pending_claim'
       RETURNING tx.id
     )
    SELECT balance.* FROM expired_balances AS balance`,
      [now],
  );

  for (const row of expired) {
    logger.info('Claimable balance expired', { balanceId: row.balance_id });
    webhook.deliver('claimable_balance.expired', row.user_id, {
      id: row.id,
      balance_id: row.balance_id,
      asset: row.asset,
      amount: row.amount,
    }).catch(() => {});

    if (row.user_id) {
      persistAndBroadcast(row.user_id, 'claimable_balance_expired', 'Claimable balance expired',
        `Your claimable balance ${row.balance_id} has expired`,
        { balance_id: row.balance_id, asset: row.asset, amount: row.amount }
      ).catch(() => {});
    }
  }

  // Claim each warning exactly once: mark and return in the same statement
  const { rows: expiringSoon } = await db.query(
    `UPDATE claimable_balances
     SET warning_sent_at = $1, updated_at = $1
     WHERE status = 'active'
       AND warning_sent_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at > $1
       AND expires_at <= $1 + ($2::int * interval '1 hour')
     RETURNING id, balance_id, user_id, asset, amount, expires_at`,
     [now, WARN_HOURS]
  );

  for (const row of expiringSoon) {
    webhook.deliver('claimable_balance.expiring_soon', row.user_id, {
      id: row.id,
      balance_id: row.balance_id,
      asset: row.asset,
      amount: row.amount,
      expires_at: row.expires_at,
    }).catch(() => {});

    if (row.user_id) {
      await notifyUser(row.user_id, row.balance_id, row.expires_at);
      persistAndBroadcast(row.user_id, 'claimable_balance_expiring', 'Claimable balance expiring soon',
        `Your claimable balance ${row.balance_id} will expire on ${new Date(row.expires_at).toUTCString()}`,
        { balance_id: row.balance_id, asset: row.asset, amount: row.amount, expires_at: row.expires_at }
      ).catch(() => {});
    }
  }

  if (expired.length > 0 || expiringSoon.length > 0) {
    logger.info('Claimable balance expiry check complete', {
      expired: expired.length,
      expiringSoon: expiringSoon.length,
    });
  }
}

module.exports = { checkClaimableBalanceExpiry };