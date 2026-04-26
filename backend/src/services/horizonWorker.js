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

// Map of publicKey -> { close, cursor } for active streams
const activeStreams = new Map();

async function startStreamForUser(userId, publicKey, cursor = 'now') {
  if (activeStreams.has(publicKey)) return;

  logger.info('Starting Horizon stream', { userId, publicKey, cursor });

  let lastCursor = cursor;

  const close = server
    .payments()
    .forAccount(publicKey)
    .cursor(lastCursor)
    .stream({
      onmessage: async (payment) => {
        // Track cursor for reconnection
        if (payment.paging_token) lastCursor = payment.paging_token;

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
        wsConnections.set(activeStreams.size);
        // Reconnect after 10 s, resuming from last seen cursor
        setTimeout(() => startStreamForUser(userId, publicKey, lastCursor), 10_000);
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
