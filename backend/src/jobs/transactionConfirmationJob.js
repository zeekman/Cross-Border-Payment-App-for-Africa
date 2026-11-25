const db = require('../db');
const logger = require('../utils/logger');
const { withFallback } = require('../services/stellar');
const { TransactionRecordSchema, validateHorizonResponse } = require('../utils/horizonSchemas');

const BATCH_SIZE = 100;

async function setFinalStatus(transactionId, status) {
  await db.query(
    `UPDATE transactions
     SET status = $2, confirmed_at = NOW()
     WHERE id = $1 AND status = 'confirming'`,
    [transactionId, status],
  );
}

async function reconcileTransactionConfirmations() {
  const { rows } = await db.query(
    `SELECT id, tx_hash, confirmation_expires_at
     FROM transactions
     WHERE status = 'confirming' AND tx_hash IS NOT NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [BATCH_SIZE],
  );

  for (const transaction of rows) {
    try {
      const raw = await withFallback(
        server => server.transactions().transaction(transaction.tx_hash).call(),
        'transactions.transaction(confirmation)',
      );
      const record = validateHorizonResponse(TransactionRecordSchema, raw, 'transactions.transaction(confirmation)');
      await setFinalStatus(transaction.id, record.successful ? 'completed' : 'failed');
    } catch (err) {
      const isNotFound = err.response?.status === 404;
      const expired = transaction.confirmation_expires_at
        && new Date(transaction.confirmation_expires_at).getTime() <= Date.now();

      if (isNotFound && expired) {
        await setFinalStatus(transaction.id, 'failed');
      } else if (!isNotFound) {
        logger.warn('Transaction confirmation lookup failed; leaving payment confirming', {
          transactionId: transaction.id,
          txHash: transaction.tx_hash,
          error: err.message,
        });
      }
    }
  }
}

module.exports = { reconcileTransactionConfirmations };