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
 *   3. BE-150: rows are claimed with a lease (`claimed_at`/`claimed_by`).
 *      Rows stuck in `processing` past the lease are reclaimable, and a
 *      reclaimed row is reconciled against Horizon via a deterministic memo
 *      before re-sending, so a crash mid-flight never double-pays.
 */
const crypto = require('crypto');
const db = require('../db');
const { sendPayment } = require('../services/stellar');
const logger = require('../utils/logger');
const { withLock } = require('../utils/distributedLock');
const { buildFeeBreakdown, collectPlatformFee } = require('../services/fees');

const LOCK_KEY = 'lock:scheduled_payments';
const LOCK_TTL = parseInt(process.env.SCHEDULED_JOB_LOCK_TTL_SECS || '55', 10);

// BE-150: lease duration for a claimed row. Rows in `processing` whose
// `claimed_at` is older than this are considered abandoned (crash/deploy)
// and become reclaimable by the next run.
const LEASE_MINUTES = parseInt(process.env.SCHEDULED_PAYMENT_LEASE_MINUTES || '10', 10);

// BE-150: Prometheus gauge for rows stuck in `processing` past the lease.
// Documented in backend/docs/metrics.md as `scheduled_payments_stuck_total`.
let stuckGauge = null;
try {
  // eslint-disable-next-line global-require
  const promClient = require('prom-client');
  stuckGauge = new promClient.Gauge({
    name: 'scheduled_payments_stuck_total',
    help: 'Scheduled payments stuck in processing past their lease (reclaimable).',
  });
} catch (_) {
  // prom-client not installed — metric emission is best-effort.
}

// Deterministic idempotency marker for a scheduled payment run. Used as the
// Stellar memo so a reclaimed row can be reconciled against Horizon.
function idempotencyMemo(payment) {
  const runAt = payment.run_at instanceof Date ? payment.run_at.toISOString() : String(payment.run_at);
  return crypto.createHash('sha256').update(`${payment.id}:${runAt}`).digest('hex').slice(0, 28);
}

// Claim a batch of due payments atomically to avoid double-processing.
// BE-150: also reclaim rows abandoned in `processing` past the lease.
async function claimDuePayments() {
  const { rows } = await db.query(
    `UPDATE scheduled_payments
     SET status = 'processing',
         claimed_at = NOW(),
         claimed_by = $2,
         updated_at = NOW()
     WHERE id IN (
       SELECT id FROM scheduled_payments
       WHERE (status = 'pending' AND run_at <= NOW())
          OR (status = 'processing' AND claimed_at < NOW() - ($1 || ' minutes')::interval)
       ORDER BY run_at
       LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [String(LEASE_MINUTES), process.env.HOSTNAME || 'unknown']
  );
  return rows;
}

// BE-150: count rows currently stuck in `processing` past the lease and
// publish them to the Prometheus gauge.
async function reportStuckPayments() {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS stuck FROM scheduled_payments
       WHERE status = 'processing' AND claimed_at < NOW() - ($1 || ' minutes')::interval`,
      [String(LEASE_MINUTES)]
    );
    const stuck = rows[0] ? rows[0].stuck : 0;
    if (stuckGauge) stuckGauge.set(stuck);
    if (stuck > 0) {
      logger.warn('Scheduled payments stuck in processing past lease', { stuck, leaseMinutes: LEASE_MINUTES });
    }
  } catch (err) {
    logger.error('Failed to report stuck scheduled payments', { error: err.message });
  }
}

// BE-150: look up Horizon for a transaction carrying the deterministic memo.
// Returns the matching transaction hash if the payment already landed.
async function findExistingPayment(payment) {
  const memo = idempotencyMemo(payment);
  try {
    // eslint-disable-next-line global-require
    const { server } = require('../services/stellar');
    if (!server || typeof server.transactions !== 'function') return null;
    const txs = await server
      .transactions()
      .forAccount(payment.sender_wallet)
      .order('desc')
      .limit(50)
      .call();
    const match = (txs.records || []).find((tx) => tx.memo === memo);
    return match ? match.hash : null;
  } catch (err) {
    logger.error('Failed to reconcile scheduled payment against Horizon', {
      id: payment.id,
      error: err.message,
    });
    return null;
  }
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

  // BE-150: if this row was reclaimed (already in `processing` before this
  // claim), check whether the payment already landed on-chain before
  // re-sending, to avoid a double payment.
  let transactionHash;
  let ledger;
  if (payment.claimed_at && payment.status === 'processing') {
    const existingHash = await findExistingPayment(payment);
    if (existingHash) {
      transactionHash = existingHash;
      logger.info('Reconciled already-executed scheduled payment', {
        id: payment.id,
        tx_hash: existingHash,
      });
    }
  }

  if (!transactionHash) {
    const result = await sendPayment({
      senderPublicKey: payment.sender_wallet,
      encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: payment.recipient_wallet,
      amount: payment.amount,
      asset: payment.asset,
      memo: payment.memo || idempotencyMemo(payment),
    });
    transactionHash = result.transactionHash;
    ledger = result.ledger;
  }
  const feeBreakdown = await buildFeeBreakdown(payment.amount, payment.asset);
  const { transactionHash, ledger } = await sendPayment({
    senderPublicKey: payment.sender_wallet,
    encryptedSecretKey: encrypted_secret_key,
    recipientPublicKey: payment.recipient_wallet,
    amount: feeBreakdown.net_amount,
    asset: payment.asset,
    memo: payment.memo,
  });

  // BE-149: The on-chain send already succeeded at this point. Any DB failure
  // below must NOT flip the schedule to 'failed' (that would let a user retry
  // and pay twice). Wrap the transaction insert + schedule advance in a single
  // DB transaction so they commit atomically, and swallow post-send DB errors
  // so the row is never marked failed after a successful payment.
  const freq = (payment.frequency || '').toLowerCase();
  const isRecurring = freq === 'daily' || freq === 'weekly' || freq === 'monthly';

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO transactions (sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed')`,
      [payment.sender_wallet, payment.recipient_wallet, payment.amount, payment.asset, payment.memo, transactionHash]
  await db.query(
    `INSERT INTO transactions (sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, fee_amount, fee_breakdown)
     VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, $8)`,
    [payment.sender_wallet, payment.recipient_wallet, payment.amount, payment.asset, payment.memo, transactionHash, feeBreakdown.platform_fee_amount, JSON.stringify(feeBreakdown)]
  );
  collectPlatformFee(feeBreakdown, payment.sender_wallet);

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
           claimed_at = NULL,
           claimed_by = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [payment.id]
    );
  } else {
    await db.query(
      `UPDATE scheduled_payments
       SET status = 'completed', claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
       WHERE id = $1`,
      [payment.id]
    );

    // Advance the schedule for recurring payments instead of marking them
    // completed after the first execution. This keeps the job in sync with
    // the `execute_at`/frequency` schema exposed to the frontend.
    if (isRecurring) {
      const interval = freq === 'daily' ? '1 day' : freq === 'weekly' ? '7 days' : '1 month';
      await client.query(
        `UPDATE scheduled_payments
         SET status = 'pending',
             run_at = run_at + $2::interval,
             updated_at = NOW()
         WHERE id = $1`,
        [payment.id, interval]
      );
    } else {
      await client.query(
        `UPDATE scheduled_payments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [payment.id]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // The payment was already sent on-chain; do not mark the schedule failed.
    logger.error('Post-send DB update failed for scheduled payment', {
      id: payment.id,
      tx_hash: transactionHash,
      error: err.message,
    });
  } finally {
    client.release();
  }

  logger.info('Scheduled payment executed', { id: payment.id, tx_hash: transactionHash, ledger });
}

async function doProcess() {
  await reportStuckPayments();

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

module.exports = { processScheduledPayments, claimDuePayments, idempotencyMemo };
