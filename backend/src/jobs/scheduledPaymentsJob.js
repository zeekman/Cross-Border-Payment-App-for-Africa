/**
 * BE-025: This is the ACTIVE scheduled-payments job — registered by
 * backend/src/scheduler.js (the one wired into startScheduler() from
 * index.js) on CRON_SCHEDULED_PAYMENTS.
 *
 * Two other modules previously duplicated this responsibility with
 * near-identical names and were never wired into anything:
 *   - backend/src/jobs/scheduledPayments.js       (oldest schema: next_run_at/active)
 *   - backend/src/services/scheduledPaymentsJob.js (own setInterval loop, scheduled_at schema)
 * Both were dead code and have been removed. This is the only implementation.
 *
 * Double-execution safety:
 *   1. A distributed lock (utils/distributedLock.withLock) ensures only one
 *      process instance runs doProcess() at a time across all app instances.
 *   2. Within a single run, claimDuePayments() uses
 *      `FOR UPDATE SKIP LOCKED` so concurrent DB transactions can't claim
 *      the same row.
 */
const db = require('../db');
const { sendPayment } = require('../services/stellar');
const logger = require('../utils/logger');
const { withLock } = require('../utils/distributedLock');

const LOCK_KEY = 'lock:scheduled_payments';
const LOCK_TTL = parseInt(process.env.SCHEDULED_JOB_LOCK_TTL_SECS || '55', 10);

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

  // Advance the schedule for recurring payments instead of marking them
  // completed after the first execution. This keeps the job in sync with
  // the `execute_at`/frequency` schema exposed to the frontend.
  const freq = (payment.frequency || '').toLowerCase();
  if (freq === 'daily' || freq === 'weekly' || freq === 'monthly') {
    const interval = freq === 'daily' ? '1 day' : freq === 'weekly' ? '7 days' : '1 month';
    await db.query(
      `UPDATE scheduled_payments
       SET status = 'pending',
           run_at = run_at + $interval::interval,
           updated_at = NOW()
       WHERE id = $1`,
      [payment.id]
    );
  } else {
    await db.query(
      `UPDATE scheduled_payments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [payment.id]
    );
  }

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

async function processScheduledPayments() {
  const ran = await withLock(LOCK_KEY, LOCK_TTL, doProcess);
  if (!ran) {
    logger.info('Scheduled payments job skipped — lock held by another instance.');
  }
}

module.exports = { processScheduledPayments };
