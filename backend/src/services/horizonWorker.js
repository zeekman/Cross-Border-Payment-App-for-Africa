/**
 * Horizon Streaming Worker
 * Streams incoming payments for all users with a push subscription
 * and fires Web Push notifications when a payment is received.
 *
 * Issue #242: Implements exponential backoff reconnection on stream error/close.
 *   - Starts at 1 s, caps at 60 s.
 *   - Logs each attempt with attempt number and delay.
 *   - After 10 consecutive failures, logs logger.error and stops retrying.
 */
const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../db');
const { sendPushToUser } = require('../controllers/notificationController');
const logger = require('../utils/logger');
const { wsConnections } = require('../utils/metrics');

const server = new StellarSdk.Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

// Reconnection constants (issue #242)
const RECONNECT_BASE_MS = 1_000;   // 1 s
const RECONNECT_CAP_MS  = 60_000;  // 60 s
const MAX_RECONNECT_ATTEMPTS = 10;

// Map of publicKey -> { close, cursor } for active streams
const activeStreams = new Map();

/**
 * Compute exponential backoff delay (with full-jitter to avoid thundering herd).
 * delay = random(0, min(cap, base * 2^attempt))
 */
function backoffDelay(attempt) {
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceiling) + RECONNECT_BASE_MS;
}

/**
 * Open a Horizon payment stream for a single user/wallet.
 *
 * @param {string|number} userId
 * @param {string}        publicKey
 * @param {string}        [cursor='now']
 * @param {number}        [consecutiveFailures=0]  – tracks backoff state across reconnects
 */
async function startStreamForUser(userId, publicKey, cursor = 'now', consecutiveFailures = 0) {
  if (activeStreams.has(publicKey)) return;

  logger.info('Starting Horizon stream', { userId, publicKey, cursor });

  let lastCursor = cursor;

  const close = server
    .payments()
    .forAccount(publicKey)
    .cursor(lastCursor)
    .stream({
      onmessage: async (payment) => {
        // Reset failure counter on a successful message
        consecutiveFailures = 0;

        // Track cursor for reconnection
        if (payment.paging_token) lastCursor = payment.paging_token;

        // Only care about incoming payments to this account
        if (payment.type !== 'payment' || payment.to !== publicKey) return;

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
        logger.warn('Horizon stream error', { publicKey, error: err?.message });
        activeStreams.delete(publicKey);
        wsConnections.set(activeStreams.size);

        _scheduleReconnect(userId, publicKey, lastCursor, consecutiveFailures + 1);
      },
    });

  activeStreams.set(publicKey, close);
  wsConnections.set(activeStreams.size);
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 * Stops after MAX_RECONNECT_ATTEMPTS consecutive failures.
 *
 * @param {string|number} userId
 * @param {string}        publicKey
 * @param {string}        cursor
 * @param {number}        attempt  – 1-based consecutive failure count
 */
function _scheduleReconnect(userId, publicKey, cursor, attempt) {
  if (attempt > MAX_RECONNECT_ATTEMPTS) {
    logger.error(
      'Horizon stream: max reconnection attempts reached, giving up',
      { publicKey, maxAttempts: MAX_RECONNECT_ATTEMPTS }
    );
    return;
  }

  const delay = backoffDelay(attempt - 1);
  logger.info('Horizon stream: scheduling reconnect', {
    publicKey,
    attempt,
    delayMs: delay,
  });

  setTimeout(() => {
    startStreamForUser(userId, publicKey, cursor, attempt);
  }, delay);
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

module.exports = {
  initStreams,
  startStreamForUser,
  stopStreamForUser,
  // Exported for testing
  _scheduleReconnect,
  backoffDelay,
  MAX_RECONNECT_ATTEMPTS,
};
