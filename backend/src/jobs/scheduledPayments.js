const db = require('../db');
const { sendPayment } = require('../services/stellar');
const logger = require('../utils/logger');

async function processScheduledPayments() {
  try {
    // Get all due scheduled payments
    const result = await db.query(
      `SELECT sp.id, sp.user_id, w.public_key, w.encrypted_secret_key, 
              sp.recipient_wallet, sp.amount, sp.asset, sp.frequency, sp.memo, sp.failed_attempts
       FROM scheduled_payments sp
       JOIN wallets w ON sp.user_id = w.user_id
       WHERE sp.active = true AND sp.next_run_at <= NOW()
       LIMIT 100`
    );

    for (const payment of result.rows) {
      try {
        // Send payment
        await sendPayment({
          senderPublicKey: payment.public_key,
          encryptedSecretKey: payment.encrypted_secret_key,
          recipientPublicKey: payment.recipient_wallet,
          amount: payment.amount,
          asset: payment.asset,
          memo: payment.memo
        });

        // Calculate next run time
        const nextRun = new Date();
        if (payment.frequency === 'daily') {
          nextRun.setDate(nextRun.getDate() + 1);
        } else if (payment.frequency === 'weekly') {
          nextRun.setDate(nextRun.getDate() + 7);
        } else if (payment.frequency === 'monthly') {
          nextRun.setMonth(nextRun.getMonth() + 1);
        }

        // Update scheduled payment
        await db.query(
          `UPDATE scheduled_payments
           SET next_run_at = $1, last_run_at = NOW(), failed_attempts = 0
           WHERE id = $2`,
          [nextRun, payment.id]
        );

        logger.info('Scheduled payment processed', { paymentId: payment.id });
      } catch (err) {
        // Retry once, then mark as failed
        if (payment.failed_attempts < 1) {
          await db.query(
            `UPDATE scheduled_payments
             SET failed_attempts = failed_attempts + 1, next_run_at = NOW() + INTERVAL '1 hour'
             WHERE id = $1`,
            [payment.id]
          );
        } else {
          await db.query(
            `UPDATE scheduled_payments
             SET active = false
             WHERE id = $1`,
            [payment.id]
          );
          logger.error('Scheduled payment failed', { paymentId: payment.id, error: err.message });
        }
      }
    }
  } catch (err) {
    logger.error('Error processing scheduled payments', { error: err.message });
  }
}

module.exports = { processScheduledPayments };
