const db = require('../db');
const { sendPayment } = require('../services/stellar');
const logger = require('../utils/logger');

// Claim a batch of due payments atomically to avoid double-processing
async function claimDuePayments() {
  const { rows } = await db.query(
    `UPDATE scheduled_payments
     SET status = 'processing', updated_at = NOW()
     WHERE id IN (
       SELECT id FROM scheduled_payments
       WHERE status = 'pending' AND run_at <= NOW()
       ORDER BY run_at
       LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  return rows;
}

async function processOne(payment) {
  const walletResult = await db.query(
    'SELECT encrypted_secret_key FROM wallets WHERE public_key = $1',
    [payment.sender_wallet]
  );

  if (!walletResult.rows[0]) {
    throw new Error(`Wallet not found for public_key ${payment.sender_wallet}`);
  }

  const { encrypted_secret_key } = walletResult.rows[0];

  const { transactionHash, ledger } = await sendPayment({
    senderPublicKey: payment.sender_wallet,
    encryptedSecretKey: encrypted_secret_key,
    recipientPublicKey: payment.recipient_wallet,
    amount: payment.amount,
    asset: payment.asset,
    memo: payment.memo,
  });

  await db.query(
    `INSERT INTO transactions (sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'completed')`,
    [payment.sender_wallet, payment.recipient_wallet, payment.amount, payment.asset, payment.memo, transactionHash]
  );

  await db.query(
    `UPDATE scheduled_payments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
    [payment.id]
  );

  logger.info('Scheduled payment executed', { id: payment.id, tx_hash: transactionHash, ledger });
}

async function doProcess() {
  let payments;
  try {
    payments = await claimDuePayments();
  } catch (err) {
    logger.error('Failed to claim scheduled payments', { error: err.message });
    return;
  }

  if (payments.length === 0) return;

  logger.info(`Processing ${payments.length} scheduled payment(s)`);

  await Promise.allSettled(
    payments.map(async (payment) => {
      try {
        await processOne(payment);
      } catch (err) {
        logger.error('Scheduled payment failed', { id: payment.id, error: err.message });
        await db.query(
          `UPDATE scheduled_payments
           SET status = 'failed', last_error = $1, updated_at = NOW()
           WHERE id = $2`,
          [err.message, payment.id]
        ).catch(() => {});
      }
    })
  );
}

// BE-221: cross-instance locking is handled by scheduler safeJob()
async function processScheduledPayments(ctx) {
  return doProcess(ctx);
}

module.exports = { processScheduledPayments };
