const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../db');
const logger = require('../utils/logger');
const cache = require('../utils/cache');
const { wsConnections } = require('../utils/metrics');

const server = new StellarSdk.Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

// The ledger-level payments stream is network-wide, so silence this long means it is stale.
const GLOBAL_STREAM_STALE_MS = 120_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_FAILURES_BEFORE_ALERT = 10;

const activeStreams = new Map();
// Last-known ledger sequence seen per stream key, derived from paging_token.
// Used to detect gaps (missed ledgers) across a reconnect.
const lastLedgerSeqByKey = new Map();
let io = null;

const healthState = {
  status: 'connected',
  last_event_at: null,
  reconnect_attempts: 0,
  // Reconnect / gap metrics (BE-027)
  total_reconnects: 0,
  total_gaps_detected: 0,
  last_gap_size: 0,
  last_gap_at: null,
};

/**
 * Horizon paging tokens for transaction/payment/effect streams encode the
 * ledger sequence in the high 32 bits: token = (ledgerSeq << 32) | txOrder.
 * Decoding it lets us detect missed ledgers across a reconnect without a
 * separate ledgers() stream.
 */
function ledgerSeqFromPagingToken(pagingToken) {
  try {
    if (!pagingToken || pagingToken === 'now') return null;
    return Number(BigInt(pagingToken) >> 32n);
  } catch {
    return null;
  }
}

/**
 * Compares the last ledger sequence seen before a disconnect to the first
 * ledger sequence seen after reconnecting. Streams resume from the last
 * persisted cursor (not "now"), so Horizon normally replays any events in
 * between — this is a safety-net check for the case where that assumption
 * doesn't hold (e.g. the cached cursor expired/was evicted and the stream
 * fell back to "now").
 */
function checkForGap(key, newLedgerSeq) {
  const previousSeq = lastLedgerSeqByKey.get(key);
  if (previousSeq != null && newLedgerSeq != null && newLedgerSeq > previousSeq + 1) {
    const gapSize = newLedgerSeq - previousSeq - 1;
    healthState.total_gaps_detected += 1;
    healthState.last_gap_size = gapSize;
    healthState.last_gap_at = new Date().toISOString();
    logger.error('Ledger gap detected after stream reconnect', {
      key,
      lastSeenLedger: previousSeq,
      firstLedgerAfterReconnect: newLedgerSeq,
      gapSize,
    });
    fireAlert(
      `LedgerListener: detected a gap of ${gapSize} ledger(s) for ${key} ` +
      `(last seen ${previousSeq}, resumed at ${newLedgerSeq}). Backfill via Horizon may be required.`
    );
  }
  if (newLedgerSeq != null) {
    lastLedgerSeqByKey.set(key, newLedgerSeq);
  }
}

function setSocketIO(socketIO) {
  io = socketIO;
}

function getHealth() {
  return { ...healthState };
}

function backoffMs(attempt) {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

async function fireAlert(message) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const body = JSON.stringify({ text: message });
    await new Promise((resolve) => {
      const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, resolve);
      req.on('error', () => {});
      req.write(body);
      req.end();
    });
  } catch {}
}

// Reference count of connected sockets per wallet. Per-account streams exist
// only while at least one socket for that wallet is connected (BE-135).
const accountRefs = new Map();
// publicKey -> userId for wallets with a Web Push subscription. Served by the
// single ledger-level payments stream, so no per-user stream is opened.
const pushTargets = new Map();

let globalPaymentsClose = null;
let globalLastEventAt = 0;
let globalLivenessTimer = null;
let stopped = false;

function updateStreamMetric() {
  wsConnections.set(activeStreams.size + (globalPaymentsClose ? 1 : 0));
}

function getStreamCount() {
  return activeStreams.size + (globalPaymentsClose ? 1 : 0);
}

function isWanted(publicKey) {
  return !stopped && (accountRefs.get(publicKey) || 0) > 0;
}

async function startStreamForAccount(publicKey, attempt = 0) {
  if (activeStreams.has(publicKey)) return;

  if (attempt > 0) {
    healthState.status = 'reconnecting';
    healthState.reconnect_attempts = attempt;
    healthState.total_reconnects += 1;
    const delay = backoffMs(attempt - 1);
    logger.info('Reconnecting transaction stream', { publicKey, attempt, delayMs: delay });
    await new Promise((r) => setTimeout(r, delay).unref());
    if (attempt >= MAX_FAILURES_BEFORE_ALERT) {
      fireAlert(`LedgerListener: ${MAX_FAILURES_BEFORE_ALERT} consecutive tx stream failures for ${publicKey}`);
    }
  }
  // The last socket may have disconnected while we were backing off.
  if (!isWanted(publicKey) || activeStreams.has(publicKey)) return;

  logger.info('Starting transaction stream', { publicKey });

  let pagingToken = 'now';
  try {
    const cached = await cache.get(`ledger:cursor:tx:${publicKey}`);
    if (cached) pagingToken = cached;
  } catch {}
  if (!isWanted(publicKey) || activeStreams.has(publicKey)) return;

  const close = server
    .transactions()
    .forAccount(publicKey)
    .cursor(pagingToken)
    .stream({
      onmessage: async (tx) => {
        attempt = 0;
        healthState.last_event_at = new Date().toISOString();
        healthState.status = 'connected';
        healthState.reconnect_attempts = 0;
        checkForGap(publicKey, ledgerSeqFromPagingToken(tx.paging_token));
        cache.set(`ledger:cursor:tx:${publicKey}`, tx.paging_token, 3600).catch(() => {});
        try {
          await db.query(
            `UPDATE transactions SET status = 'completed', confirmed_at = NOW()
             WHERE transaction_hash = $1 AND status = 'pending'`,
            [tx.hash]
          );
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
        logger.warn('Transaction stream error', { publicKey, attempt, error: err?.message });
        const current = activeStreams.get(publicKey);
        if (current !== close) return; // already stopped/replaced
        try { close(); } catch {}
        activeStreams.delete(publicKey);
        updateStreamMetric();
        startStreamForAccount(publicKey, attempt + 1);
      },
    });

  activeStreams.set(publicKey, close);
  updateStreamMetric();
  if (attempt === 0) {
    healthState.status = 'connected';
    healthState.reconnect_attempts = 0;
  }
}

function handleGlobalPayment(payment) {
  globalLastEventAt = Date.now();
  healthState.last_event_at = new Date().toISOString();
  cache.set('ledger:cursor:pay:global', payment.paging_token, 3600).catch(() => {});
  if (payment.type !== 'payment') return;
  const to = payment.to;
  const watchedBySocket = accountRefs.has(to);
  const pushUserId = pushTargets.get(to);
  if (!watchedBySocket && !pushUserId) return;

  const amount = payment.amount;
  const asset = payment.asset_type === 'native' ? 'XLM' : payment.asset_code;
  const from = payment.from;

  if (watchedBySocket && io) {
    io.to(to).emit('payment:received', {
      from, to, amount, asset,
      hash: payment.transaction_hash,
      timestamp: payment.created_at,
    });
  }
  if (pushUserId) {
    // Lazy require: notificationController depends on this module.
    const { sendPushToUser } = require('../controllers/notificationController');
    sendPushToUser(pushUserId, {
      title: 'Payment Received',
      body: `You received ${amount} ${asset}`,
      data: { from, amount, asset, txHash: payment.transaction_hash },
    }).catch((err) => logger.warn('Push send failed', { userId: pushUserId, error: err.message }));
  }
  logger.info('Payment received', { to, amount, asset, from });
}

/**
 * One ledger-level payments stream, filtered in-process against connected
 * wallets and push subscribers, instead of one stream per account.
 */
async function startGlobalPaymentStream(attempt = 0) {
  if (globalPaymentsClose || stopped) return;

  if (attempt > 0) {
    healthState.total_reconnects += 1;
    const delay = backoffMs(attempt - 1);
    logger.info('Reconnecting ledger payments stream', { attempt, delayMs: delay });
    await new Promise((r) => setTimeout(r, delay).unref());
    if (attempt >= MAX_FAILURES_BEFORE_ALERT) {
      fireAlert(`LedgerListener: ${MAX_FAILURES_BEFORE_ALERT} consecutive ledger payments stream failures`);
    }
    if (globalPaymentsClose || stopped) return;
  }

  let pagingToken = 'now';
  try {
    const cached = await cache.get('ledger:cursor:pay:global');
    if (cached) pagingToken = cached;
  } catch {}
  if (globalPaymentsClose || stopped) return;

  globalLastEventAt = Date.now();
  const close = server
    .payments()
    .cursor(pagingToken)
    .stream({
      onmessage: (payment) => {
        attempt = 0;
        checkForGap('global:payments', ledgerSeqFromPagingToken(payment.paging_token));
        try { handleGlobalPayment(payment); } catch (err) {
          logger.warn('Failed to process payment', { error: err.message });
        }
      },
      onerror: (err) => {
        logger.warn('Ledger payments stream error', { attempt, error: err?.message });
        restartGlobalPaymentStream(attempt + 1);
      },
    });
  globalPaymentsClose = close;
  updateStreamMetric();

  // Per-stream liveness: only this stream is restarted when it goes quiet.
  if (!globalLivenessTimer) {
    globalLivenessTimer = setInterval(() => {
      if (globalPaymentsClose && Date.now() - globalLastEventAt > GLOBAL_STREAM_STALE_MS) {
        logger.warn('Ledger payments stream stale, reconnecting');
        restartGlobalPaymentStream(1);
      }
    }, GLOBAL_STREAM_STALE_MS);
    globalLivenessTimer.unref();
  }
}

function restartGlobalPaymentStream(attempt) {
  if (globalPaymentsClose) {
    try { globalPaymentsClose(); } catch {}
    globalPaymentsClose = null;
    updateStreamMetric();
  }
  startGlobalPaymentStream(attempt);
}

/** Called when a socket for this wallet connects. */
function acquireAccount(publicKey) {
  accountRefs.set(publicKey, (accountRefs.get(publicKey) || 0) + 1);
  startStreamForAccount(publicKey);
}

/** Called when a socket for this wallet disconnects; closes streams on the last one. */
function releaseAccount(publicKey) {
  const n = (accountRefs.get(publicKey) || 0) - 1;
  if (n > 0) {
    accountRefs.set(publicKey, n);
    return;
  }
  accountRefs.delete(publicKey);
  stopStream(publicKey);
}

function addPushTarget(userId, publicKey) {
  pushTargets.set(publicKey, userId);
}

function removePushTarget(publicKey) {
  pushTargets.delete(publicKey);
}

function stopStream(publicKey) {
  const close = activeStreams.get(publicKey);
  if (close) {
    activeStreams.delete(publicKey);
    try { close(); } catch {}
    updateStreamMetric();
  }
}

/** Boot: load push subscribers and open the single ledger-level payments stream. */
async function initStreams() {
  stopped = false;
  try {
    const { rows } = await db.query(
      `SELECT u.id, w.public_key
       FROM users u
       JOIN wallets w ON w.user_id = u.id
       WHERE u.push_subscription IS NOT NULL`
    );
    for (const row of rows) pushTargets.set(row.public_key, row.id);
    logger.info('Ledger listener initialized', { pushTargets: rows.length });
  } catch (err) {
    logger.error('Failed to load push targets', { error: err.message });
  }
  startGlobalPaymentStream();
}

/** Close every Horizon stream (used on shutdown). */
function stopAll() {
  stopped = true;
  if (globalLivenessTimer) {
    clearInterval(globalLivenessTimer);
    globalLivenessTimer = null;
  }
  if (globalPaymentsClose) {
    try { globalPaymentsClose(); } catch {}
    globalPaymentsClose = null;
  }
  for (const key of [...activeStreams.keys()]) stopStream(key);
  accountRefs.clear();
  updateStreamMetric();
}

module.exports = {
  setSocketIO,
  startStreamForAccount,
  acquireAccount,
  releaseAccount,
  addPushTarget,
  removePushTarget,
  stopStream,
  stopAll,
  initStreams,
  getHealth,
  getStreamCount,
};
