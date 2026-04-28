/**
 * Scheduled Payments Job
 *
 * Polls the `scheduled_payments` table every minute for payments that are due.
 * For each due payment it:
 *   1. Claims the row with a `processing` status (skip-locked) to prevent
 *      duplicate execution across multiple server instances.
 *   2. Attempts the Stellar broadcast.
 *   3. On success  → status = 'completed', tx_hash recorded.
 *   4. On failure  → retry_count++, last_error recorded.
 *                    After MAX_RETRIES failures → status = 'failed'.
 *                    Otherwise → status reset to 'pending' for the next run.
 */

const db = require('../db');
const { sendPayment } = require('./stellar');
const logger = require('../utils/logger');

const POLL_INTERVAL_MS = 60_000; // 1 minute
const MAX_RETRIES = 3;

let _timer = null;

/**
 * Fetch and lock a single batch of due payments using SKIP LOCKED so that
 * concurrent job instances never process the same row.
 *
 * Returns the locked rows (already updated to 'processing' in the same txn).
 */
async function claimDuePayments(client) {
  // Claim rows that are pending AND scheduled_at <= now, up to 50 at a time.
  // We reset any previously-failed-but-retryable rows back to 'pending' before
  // this query runs (handled in processPayment), so this only ever sees 'pending'.
  const { rows } = await client.query(
    `UPDATE scheduled_payments
        SET status     = 'processing',
            updated_at = NOW()
      WHERE id IN (
        SELECT id
          FROM scheduled_payments
         WHERE status       = 'pending'
           AND scheduled_at <= NOW()
         ORDER BY scheduled_at
         LIMIT 50
           FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id,
        user_id,
        sender_wallet,
        recipient_wallet,
        amount,
        asset,
        memo,
        memo_type,
        retry_count`
  );
  return rows;
}

/**
 * Process a single scheduled payment row.
 * Must be called inside its own DB client/transaction so we can roll back the
 * 'processing' claim if something unexpected happens before we write the outcome.
 */
async function processPayment(payment) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Re-lock this specific row so we own it for the duration of this txn.
    const { rows } = await client.query(
      `SELECT sp.id, w.encrypted_secret_key
         FROM scheduled_payments sp
         JOIN wallets w ON w.public_key = sp.sender_wallet
        WHERE sp.id     = $1
          AND sp.status = 'processing'
          FOR UPDATE`,
      [payment.id]
    );

    if (rows.length === 0) {
      // Another instance already handled this row — nothing to do.
      await client.query('ROLLBACK');
      return;
    }

    const { encrypted_secret_key } = rows[0];

    let txHash;
    try {
      const result = await sendPayment({
        senderPublicKey: payment.sender_wallet,
        encryptedSecretKey: encrypted_secret_key,
        recipientPublicKey: payment.recipient_wallet,
        amount: payment.amount,
        asset: payment.asset || 'XLM',
        memo: payment.memo || undefined,
        memoType: payment.memo_type || 'text',
      });
      txHash = result.transactionHash;
    } catch (stellarErr) {
      // Stellar broadcast failed — decide whether to retry or give up.
      const newRetryCount = payment.retry_count + 1;
      const errorMessage = extractErrorMessage(stellarErr);

      if (newRetryCount >= MAX_RETRIES) {
        // Permanently failed — stop retrying.
        await client.query(
          `UPDATE scheduled_payments
              SET status      = 'failed',
                  retry_count = $1,
                  last_error  = $2,
                  updated_at  = NOW()
            WHERE id = $3`,
          [newRetryCount, errorMessage, payment.id]
        );
        logger.warn('Scheduled payment permanently failed', {
          paymentId: payment.id,
          retryCount: newRetryCount,
          error: errorMessage,
        });
      } else {
        // Retryable — put it back to 'pending' so the next run picks it up.
        await client.query(
          `UPDATE scheduled_payments
              SET status      = 'pending',
                  retry_count = $1,
                  last_error  = $2,
                  updated_at  = NOW()
            WHERE id = $3`,
          [newRetryCount, errorMessage, payment.id]
        );
        logger.warn('Scheduled payment failed, will retry', {
          paymentId: payment.id,
          retryCount: newRetryCount,
          maxRetries: MAX_RETRIES,
          error: errorMessage,
        });
      }

      await client.query('COMMIT');
      return;
    }

    // Broadcast succeeded — mark completed and record the tx hash.
    await client.query(
      `UPDATE scheduled_payments
          SET status     = 'completed',
              tx_hash    = $1,
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $2`,
      [txHash, payment.id]
    );

    logger.info('Scheduled payment completed', {
      paymentId: payment.id,
      txHash,
    });

    await client.query('COMMIT');
  } catch (unexpectedErr) {
    // Something went wrong outside of the Stellar call (e.g. DB error).
    // Roll back so the row stays 'processing' — the next run will time it out
    // or an operator can reset it manually.
    await client.query('ROLLBACK');
    logger.error('Unexpected error processing scheduled payment', {
      paymentId: payment.id,
      error: unexpectedErr.message,
      stack: unexpectedErr.stack,
    });
  } finally {
    client.release();
  }
}

/**
 * Extract a human-readable error message from a Stellar SDK error or plain Error.
 */
function extractErrorMessage(err) {
  if (err.response?.data?.extras?.result_codes) {
    return JSON.stringify(err.response.data.extras.result_codes);
  }
  return err.message || String(err);
}

/**
 * Main job tick — called every POLL_INTERVAL_MS.
 */
async function runJob() {
  const client = await db.pool.connect();
  let payments = [];
  try {
    await client.query('BEGIN');
    payments = await claimDuePayments(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to claim scheduled payments', { error: err.message });
    return;
  } finally {
    client.release();
  }

  if (payments.length === 0) return;

  logger.info('Processing scheduled payments', { count: payments.length });

  // Process each payment sequentially to avoid hammering Stellar / the DB.
  for (const payment of payments) {
    await processPayment(payment);
  }
}

/**
 * Start the polling loop. Safe to call multiple times — only one timer runs.
 */
function start() {
  if (_timer) return;
  logger.info('Scheduled payments job started', { intervalMs: POLL_INTERVAL_MS });
  // Run immediately on startup, then on the interval.
  runJob().catch((err) =>
    logger.error('Scheduled payments job error', { error: err.message })
  );
  _timer = setInterval(() => {
    runJob().catch((err) =>
      logger.error('Scheduled payments job error', { error: err.message })
    );
  }, POLL_INTERVAL_MS);
  // Don't keep the process alive solely because of this timer.
  _timer.unref();
}

/**
 * Stop the polling loop (used in tests / graceful shutdown).
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('Scheduled payments job stopped');
  }
}

module.exports = { start, stop, runJob, MAX_RETRIES };
