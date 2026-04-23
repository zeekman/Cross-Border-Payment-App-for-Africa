/**
 * Horizon Streaming Worker
 * Streams incoming payments for all users with a push subscription
 * and fires Web Push notifications when a payment is received.
 */
const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../db');
const { sendPushToUser } = require('../controllers/notificationController');
const logger = require('../utils/logger');
const { wsConnections } = require('../utils/metrics');

const server = new StellarSdk.Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

// Map of publicKey -> close() function for active streams
const activeStreams = new Map();

async function startStreamForUser(userId, publicKey) {
  if (activeStreams.has(publicKey)) return;

  logger.info('Starting Horizon stream', { userId, publicKey });

  const close = server
    .payments()
    .forAccount(publicKey)
    .cursor('now')
    .stream({
      onmessage: async (payment) => {
        // Only care about incoming payments to this account
        if (
          payment.type !== 'payment' ||
          payment.to !== publicKey
        ) return;

        const amount = payment.amount;
        const asset =
          payment.asset_type === 'native' ? 'XLM' : payment.asset_code;
        const from = payment.from;

        await sendPushToUser(userId, {
          title: 'Payment Received',
          body: `You received ${amount} ${asset}`,
          data: { from, amount, asset, txHash: payment.transaction_hash },
        }).catch((err) =>
          logger.warn('Push send failed', { userId, error: err.message })
        );
      },
      onerror: (err) => {
        logger.warn('Horizon stream error', { publicKey, error: err.message });
        activeStreams.delete(publicKey);
        // Reconnect after 10 s
        setTimeout(() => startStreamForUser(userId, publicKey), 10_000);
      },
    });

  activeStreams.set(publicKey, close);
  wsConnections.set(activeStreams.size);
}

function stopStreamForUser(publicKey) {
  const close = activeStreams.get(publicKey);
  if (close) {
    close();
    activeStreams.delete(publicKey);
    wsConnections.set(activeStreams.size);
  }
}

/**
 * Bootstrap: open streams for every user that already has a push subscription.
 * Called once at server startup.
 */
async function initStreams() {
  try {
    const { rows } = await db.query(
      `SELECT u.id, w.public_key
       FROM users u
       JOIN wallets w ON w.user_id = u.id
       WHERE u.push_subscription IS NOT NULL`
    );
    for (const row of rows) {
      startStreamForUser(row.id, row.public_key);
    }
    logger.info('Horizon streams initialised', { count: rows.length });
  } catch (err) {
    logger.error('Failed to init Horizon streams', { error: err.message });
  }
}

module.exports = { initStreams, startStreamForUser, stopStreamForUser };
