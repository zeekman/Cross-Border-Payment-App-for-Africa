const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { anchorPollDuration } = require('../utils/metrics');

const anchorUrl = process.env.ANCHOR_URL || 'https://testanchor.stellar.org';

/**
 * Circuit breaker for anchor status polling (BE-016).
 *
 * Status polling is bounded to a fixed retry count with exponential backoff
 * (via utils/retry.js) so a slow/erroring anchor never gets hammered. If an
 * anchor keeps failing, the breaker opens for COOLDOWN_MS so we stop calling
 * it entirely — protecting us from being rate-limited/blocklisted — and
 * surfaces as unhealthy via services/health.js in the meantime.
 */
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60 * 1000;
const circuitState = new Map(); // anchorUrl -> { failures, openedAt }

function isCircuitOpen(url) {
  const state = circuitState.get(url);
  if (!state || !state.openedAt) return false;
  if (Date.now() - state.openedAt > COOLDOWN_MS) {
    circuitState.delete(url); // cooldown elapsed, allow a probe through
    return false;
  }
  return true;
}

function recordSuccess(url) {
  circuitState.delete(url);
}

function recordFailure(url) {
  const state = circuitState.get(url) || { failures: 0, openedAt: null };
  state.failures += 1;
  if (state.failures >= FAILURE_THRESHOLD) state.openedAt = Date.now();
  circuitState.set(url, state);
}

function getAnchorHealth() {
  const state = circuitState.get(anchorUrl);
  return {
    anchorUrl,
    circuitOpen: isCircuitOpen(anchorUrl),
    consecutiveFailures: state?.failures || 0,
  };
}

// Get SEP-24 info
// Cache anchor TOML info to avoid fetching on every request
let anchorInfoCache = null;
let anchorInfoCachedAt = 0;
const ANCHOR_INFO_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch and parse the anchor's stellar.toml, returning transfer server URLs.
 * Results are cached for ANCHOR_INFO_TTL_MS to avoid hammering the anchor.
 */
async function getAnchorInfo() {
  const now = Date.now();
  if (anchorInfoCache && now - anchorInfoCachedAt < ANCHOR_INFO_TTL_MS) {
    return anchorInfoCache;
  }

  try {
    const response = await fetch(`${anchorUrl}/.well-known/stellar.toml`);
    if (!response.ok) {
      throw new Error(`stellar.toml fetch failed: ${response.status}`);
    }
    const text = await response.text();

    // SEP-24 interactive transfer server
    const sep24Match = text.match(/TRANSFER_SERVER_SEP0024\s*=\s*"([^"]+)"/);
    // SEP-6 non-interactive transfer server (fallback)
    const sep6Match = text.match(/TRANSFER_SERVER\s*=\s*"([^"]+)"/);

    const info = {
      transferServerSep24: sep24Match ? sep24Match[1] : null,
      transferServerSep6: sep6Match ? sep6Match[1] : null,
      anchorUrl,
    };

    anchorInfoCache = info;
    anchorInfoCachedAt = now;
    return info;
  } catch (err) {
    logger.error('Failed to get anchor info', { error: err.message });
    throw new Error('Failed to connect to anchor');
  }
}

/**
 * Initiate a SEP-24 interactive deposit.
 * Returns { url, id } — the caller must redirect the user to `url`.
 *
 * @param {string} userPublicKey  - User's Stellar public key
 * @param {string} asset          - Asset code (e.g. "USDC")
 * @param {string} sep10Jwt       - SEP-10 JWT issued by the anchor for this user
 * @param {object} [extra]        - Optional extra fields (amount, memo, etc.)
 */
async function initiateDeposit(userPublicKey, asset, sep10Jwt, extra = {}) {
  const { transferServerSep24 } = await getAnchorInfo();
  if (!transferServerSep24) throw new Error('Anchor does not support SEP-24');

  const body = new URLSearchParams({
    asset_code: asset,
    account: userPublicKey,
    ...extra,
  });

  const response = await fetch(`${transferServerSep24}/transactions/deposit/interactive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(sep10Jwt ? { Authorization: `Bearer ${sep10Jwt}` } : {}),
    },
    body: body.toString(),
  });

  const data = await response.json();

  if (!response.ok || data.type === 'error') {
    logger.error('Anchor deposit initiation failed', { status: response.status, data });
    throw new Error(data.error || 'Anchor deposit initiation failed');
  }

  if (data.type !== 'interactive_customer_info_needed' || !data.url) {
    throw new Error('Unexpected anchor response: missing interactive URL');
  }

  return { url: data.url, id: data.id };
}

/**
 * Initiate a SEP-24 interactive withdrawal.
 * Returns { url, id } — the caller must redirect the user to `url`.
 *
 * @param {string} userPublicKey  - User's Stellar public key
 * @param {string} asset          - Asset code (e.g. "USDC")
 * @param {string} sep10Jwt       - SEP-10 JWT issued by the anchor for this user
 * @param {object} [extra]        - Optional extra fields (amount, dest, dest_extra, etc.)
 */
async function initiateWithdrawal(userPublicKey, asset, sep10Jwt, extra = {}) {
  const { transferServerSep24 } = await getAnchorInfo();
  if (!transferServerSep24) throw new Error('Anchor does not support SEP-24');

  const body = new URLSearchParams({
    asset_code: asset,
    account: userPublicKey,
    ...extra,
  });

  const response = await fetch(`${transferServerSep24}/transactions/withdraw/interactive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(sep10Jwt ? { Authorization: `Bearer ${sep10Jwt}` } : {}),
    },
    body: body.toString(),
  });

  const data = await response.json();

  if (!response.ok || data.type === 'error') {
    logger.error('Anchor withdrawal initiation failed', { status: response.status, data });
    throw new Error(data.error || 'Anchor withdrawal initiation failed');
  }

  if (data.type !== 'interactive_customer_info_needed' || !data.url) {
    throw new Error('Unexpected anchor response: missing interactive URL');
  }

  return { url: data.url, id: data.id };
}

/**
 * Poll a SEP-24 transaction by ID.
 * Requires the SEP-10 JWT so the anchor can authorise the lookup.
 *
 * @param {string} transactionId
 * @param {string} sep10Jwt
 */
// Get transaction status. Polling callers (anchorController's status route)
// should treat this as bounded: it retries with exponential backoff up to
// MAX_ATTEMPTS and trips a circuit breaker after repeated failures rather
// than being called in a tight client-driven loop with no ceiling.
async function getTransactionStatus(transactionId, sep10Jwt) {
  if (isCircuitOpen(anchorUrl)) {
    const err = new Error('Anchor is temporarily unavailable (circuit open)');
    err.status = 503;
    throw err;
  }

  const start = Date.now();
  try {
    const data = await withRetry(
      async () => {
        const { transferServerSep24 } = await getAnchorInfo();
        if (!transferServerSep24) throw new Error('Anchor does not support SEP-24');

        const url = new URL(`${transferServerSep24}/transaction`);
        url.searchParams.set('id', transactionId);

        const response = await fetch(url.toString(), {
          headers: sep10Jwt ? { Authorization: `Bearer ${sep10Jwt}` } : {},
        });
        if (!response.ok) {
          const err = new Error(`Anchor status endpoint returned ${response.status}`);
          err.status = response.status;
          throw err;
        }
        return response.json();
      },
      { maxAttempts: 3, label: `anchor status poll (${anchorUrl})` }
    );
    recordSuccess(anchorUrl);
    anchorPollDuration.observe({ anchor: anchorUrl, success: 'true' }, (Date.now() - start) / 1000);
    return data.transaction;
  } catch (err) {
    recordFailure(anchorUrl);
    anchorPollDuration.observe({ anchor: anchorUrl, success: 'false' }, (Date.now() - start) / 1000);
    logger.error('Failed to get transaction status', { error: err.message });
    throw err;
  }
}

module.exports = {
  getAnchorInfo,
  initiateDeposit,
  initiateWithdrawal,
  getTransactionStatus,
  getAnchorHealth,
};
