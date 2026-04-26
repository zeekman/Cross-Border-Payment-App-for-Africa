const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../db');
const logger = require('../utils/logger');

const server = new StellarSdk.Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

const activeStreams = new Map();
let io = null;

function setSocketIO(socketIO) {
  io = socketIO;
}

async function startStreamForAccount(publicKey) {
  if (activeStreams.has(publicKey)) return;

  logger.info('Starting payment stream', { publicKey });

  const close = server
    .transactions()
    .forAccount(publicKey)
    .cursor('now')
    .stream({
      onmessage: async (tx) => {
        try {
          // Update transaction status in DB
          await db.query(
            `UPDATE transactions SET status = 'completed', confirmed_at = NOW()
             WHERE transaction_hash = $1 AND status = 'pending'`,
            [tx.hash]
          );

          // Emit Socket.IO event to user's room
          if (io) {
            io.to(publicKey).emit('payment:confirmed', {
              hash: tx.hash,
              account: publicKey,
              timestamp: tx.created_at,
            });
          }

          logger.info('Transaction confirmed', { hash: tx.hash, account: publicKey });
        } catch (err) {
          logger.warn('Failed to process transaction', { hash: tx.hash, error: err.message });
        }
      },
      onerror: (err) => {
        logger.warn('Stream error', { publicKey, error: err.message });
        activeStreams.delete(publicKey);
        setTimeout(() => startStreamForAccount(publicKey), 10_000);
      },
    });

  activeStreams.set(publicKey, close);
}

async function startPaymentStream(publicKey) {
  if (activeStreams.has(`${publicKey}:payments`)) return;

  logger.info('Starting payment stream', { publicKey });

  const close = server
    .payments()
    .forAccount(publicKey)
    .cursor('now')
    .stream({
      onmessage: async (payment) => {
        if (payment.type !== 'payment' || payment.to !== publicKey) return;

        const amount = payment.amount;
        const asset = payment.asset_type === 'native' ? 'XLM' : payment.asset_code;
        const from = payment.from;

        // Emit Socket.IO event
        if (io) {
          io.to(publicKey).emit('payment:received', {
            from,
            to: publicKey,
            amount,
            asset,
            hash: payment.transaction_hash,
            timestamp: payment.created_at,
          });
        }

        logger.info('Payment received', { to: publicKey, amount, asset, from });
      },
      onerror: (err) => {
        logger.warn('Payment stream error', { publicKey, error: err.message });
        activeStreams.delete(`${publicKey}:payments`);
        setTimeout(() => startPaymentStream(publicKey), 10_000);
      },
    });

  activeStreams.set(`${publicKey}:payments`, close);
}

function stopStream(publicKey) {
  const txClose = activeStreams.get(publicKey);
  const payClose = activeStreams.get(`${publicKey}:payments`);
  
  if (txClose) {
    txClose();
    activeStreams.delete(publicKey);
  }
  if (payClose) {
    payClose();
    activeStreams.delete(`${publicKey}:payments`);
  }
}

async function initStreams() {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT w.public_key
       FROM wallets w
       JOIN users u ON u.id = w.user_id
       WHERE u.email_verified = TRUE`
    );
    
    for (const row of rows) {
      startStreamForAccount(row.public_key);
      startPaymentStream(row.public_key);
    }
    
    logger.info('Ledger streams initialized', { count: rows.length });
  } catch (err) {
    logger.error('Failed to init ledger streams', { error: err.message });
  }
}

module.exports = {
  setSocketIO,
  startStreamForAccount,
  startPaymentStream,
  stopStream,
  initStreams,
};
