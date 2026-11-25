'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const logger = require('../utils/logger');
const { mintPoints } = require('../services/loyaltyToken');
const { persistAndBroadcast } = require('../services/notificationInbox');
const { withLock } = require('../utils/distributedLock');

const XLM_USD_RATE = parseFloat(process.env.XLM_USD_RATE || '0.11');
const MIN_PAYMENT_XLM_EQUIVALENT = parseFloat(process.env.MIN_LOYALTY_PAYMENT_XLM || '1.0');

function estimateXlmEquivalent(amount, asset) {
  const num = parseFloat(amount);
  if (asset === 'XLM') return num;
  if (asset === 'USDC' || asset === 'USD') return num / XLM_USD_RATE;
  
  // For unsupported assets, use conservative 1:1 USD estimate to prevent
  // point farming with worthless tokens (Issue #1162).
  // In production, integrate a live price feed for NGN, GHS, KES, etc.
  logger.warn('estimateXlmEquivalent: unsupported asset, using 1:1 USD fallback', { asset, amount });
  return num / XLM_USD_RATE;
}

/**
 * Claim one pending queue row inside a single transaction.
 *
 * The SELECT FOR UPDATE and the UPDATE status='processing' are issued on the
 * SAME dedicated client within a BEGIN/COMMIT block, so the row lock is held
 * continuously between the two statements.  SKIP LOCKED means a second
 * concurrent caller will simply find no row and return null rather than
 * blocking or racing.
 *
 * @param {import('pg').PoolClient} client — a checked-out pg client
 * @returns {Promise<object|null>} the claimed row, or null if queue is empty
 */
async function claimNextJob(client) {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(
      `SELECT lq.id, lq.user_id, lq.sender_wallet, lq.amount, lq.asset,
              lq.retry_count,
              t.status  AS tx_status,
              t.tx_hash
       FROM   loyalty_mint_queue lq
       JOIN   transactions t ON t.id = lq.id
       WHERE  lq.status = 'pending'
         AND  t.status  = 'completed'
       ORDER  BY lq.created_at ASC
       LIMIT  1
       FOR UPDATE OF lq SKIP LOCKED`,
    );

    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const job = rows[0];

    // Mark as 'processing' while still inside the transaction.
    // No other session can see this row as 'pending' until we COMMIT.
    await client.query(
      `UPDATE loyalty_mint_queue
       SET    status = 'processing',
              retry_count = retry_count + 1
       WHERE  id = $1`,
      [job.id],
    );

    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function processLoyaltyMintQueue() {
  const CONCURRENCY = parseInt(process.env.LOYALTY_MINT_CONCURRENCY || '5', 10);

  for (let i = 0; i < CONCURRENCY; i++) {
    // Defense-in-depth: a per-slot distributed lock stops a second replica from
    // racing into the same slot concurrently.  The DB transaction in claimNextJob
    // is the primary guard; this lock is a belt-and-suspenders layer.
    const lockKey = `loyalty_mint_slot:${i}`;

    try {
    const ran = await withLock(lockKey, 30, async () => {
      const client = await db.pool.connect();
      try {
        const job = await claimNextJob(client);
        if (!job) return; // queue empty for this slot

        const xlmEquivalent = estimateXlmEquivalent(job.amount, job.asset);
        
        // Issue #1162: Prevent point farming with dust payments by enforcing
        // a minimum payment threshold. Skip minting if payment is below minimum.
        if (xlmEquivalent < MIN_PAYMENT_XLM_EQUIVALENT) {
          await db.query(
            `UPDATE loyalty_mint_queue
             SET    status = 'completed',
                    completed_at = NOW()
             WHERE  id = $1`,
            [job.id],
          );
          logger.info('Loyalty mint skipped: payment below minimum threshold', {
            jobId: job.id,
            xlmEquivalent,
            minRequired: MIN_PAYMENT_XLM_EQUIVALENT,
          });
          return;
        }

        const points = Math.floor(xlmEquivalent);

        try {
          const result = await mintPoints({
            recipientWallet: job.sender_wallet,
            points,
          });

          if (result) {
            await db.query(
              `UPDATE loyalty_mint_queue
               SET    status = 'completed',
                      tx_hash = $1,
                      completed_at = NOW()
               WHERE  id = $2`,
              [result.txHash, job.id],
            );

            // Record the mint in the loyalty_points off-chain ledger.
            await db.query(
              `INSERT INTO loyalty_points
                 (id, user_id, wallet_address, event_type, points, transaction_id, tx_hash)
               VALUES ($1, $2, $3, 'mint', $4, $5, $6)`,
              [
                uuidv4(),
                job.user_id,
                job.sender_wallet,
                points,
                job.id,
                result.txHash,
              ],
            );

            await persistAndBroadcast(
              job.user_id,
              'loyalty_points_earned',
              'Loyalty Points Earned',
              `You earned ${points} loyalty points for your recent payment!`,
              { points, tx_hash: result.txHash },
            ).catch(() => {});
          } else {
            // mintPoints returned null — contract not configured, still complete.
            await db.query(
              `UPDATE loyalty_mint_queue
               SET    status = 'completed',
                      completed_at = NOW()
               WHERE  id = $1`,
              [job.id],
            );
          }
        } catch (mintErr) {
          // retry_count was already incremented by claimNextJob (to pick-up value).
          const retryCount = job.retry_count || 0;
          if (retryCount < 3) {
            await db.query(
              `UPDATE loyalty_mint_queue
               SET    status = 'pending',
                      last_error = $1,
                      retry_count = retry_count + 1
               WHERE  id = $2`,
              [mintErr.message, job.id],
            );
            logger.warn('Loyalty mint deferred, will retry', {
              jobId: job.id,
              error: mintErr.message,
            });
          } else {
            await db.query(
              `UPDATE loyalty_mint_queue
               SET    status = 'failed',
                      last_error = $1,
                      completed_at = NOW()
               WHERE  id = $2`,
              [mintErr.message, job.id],
            );
            logger.error('Loyalty mint failed after max retries', {
              jobId: job.id,
              error: mintErr.message,
            });
          }
        }
      } finally {
        client.release();
      }
    });

    if (ran === false) {
      // Another replica holds this slot lock — skip silently.
      logger.warn('Loyalty mint slot locked by another replica, skipping', {
        slot: i,
        lockKey,
      });
    }
    } catch (err) {
      logger.warn('Loyalty mint queue processing error', { slot: i, error: err.message });
    }
  }
}

/**
 * Idempotently enqueue a loyalty-mint job.
 *
 * Uses ON CONFLICT DO NOTHING so that re-processing the same payment ID
 * never creates a duplicate queue row.
 */
async function enqueueLoyaltyMint(txId, userId, senderWallet, amount, asset) {
  if (!process.env.LOYALTY_TOKEN_CONTRACT_ID) return null;

  const { rows } = await db.query(
    `INSERT INTO loyalty_mint_queue (id, user_id, sender_wallet, amount, asset)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [txId, userId, senderWallet, amount, asset],
  );
  return rows[0]?.id;
}

module.exports = { processLoyaltyMintQueue, enqueueLoyaltyMint, claimNextJob };
