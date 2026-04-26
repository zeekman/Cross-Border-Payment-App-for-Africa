const db = require('../db');
const { sendExpiryNotification } = require('../services/email');
const { getClaimableBalances } = require('../services/stellar');
const logger = require('../utils/logger');

// Check for claimable balances expiring within 7 days
async function checkClaimableBalanceExpiry() {
  try {
    logger.info('Starting claimable balance expiry check');

    const { rows: transactions } = await db.query(
      `SELECT t.*, u.email as sender_email, u.full_name as sender_name
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE t.type = 'claimable_balance' AND t.status = 'pending'`
    );

    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    for (const tx of transactions) {
      const createdAt = new Date(tx.created_at).getTime();
      const expiresAt = createdAt + thirtyDaysMs;
      const timeUntilExpiry = expiresAt - now;

      // Check if expiring within 7 days
      if (timeUntilExpiry > 0 && timeUntilExpiry <= sevenDaysMs) {
        const daysLeft = Math.ceil(timeUntilExpiry / (24 * 60 * 60 * 1000));

        // Send notification to sender
        await sendExpiryNotification(
          tx.sender_email,
          tx.sender_name,
          tx.recipient_wallet,
          tx.amount,
          tx.asset,
          daysLeft,
          'sender'
        );

        // Check if recipient is registered and send notification
        const { rows: recipientRows } = await db.query(
          `SELECT u.email, u.full_name FROM users u
           JOIN wallets w ON w.user_id = u.id
           WHERE w.public_key = $1`,
          [tx.recipient_wallet]
        );

        if (recipientRows.length > 0) {
          await sendExpiryNotification(
            recipientRows[0].email,
            recipientRows[0].full_name,
            tx.recipient_wallet,
            tx.amount,
            tx.asset,
            daysLeft,
            'recipient'
          );
        }

        logger.info('Expiry notification sent', {
          txId: tx.id,
          daysLeft,
          recipient: tx.recipient_wallet
        });
      }
    }

    logger.info('Claimable balance expiry check completed');
  } catch (err) {
    logger.error('Error checking claimable balance expiry', { error: err.message });
  }
}

module.exports = checkClaimableBalanceExpiry;
