const logger = require('./logger');

const RETRYABLE_STATUSES = new Set([429, 503, 504]);
const MAX_DELAY_MS = 10_000;

const NON_RETRIABLE_TX_CODES = new Set([
  'tx_bad_auth',
  'tx_insufficient_balance',
  'tx_no_account',
  'tx_invalid_seq',
  'tx_bad_minseqage',
  'tx_bad_minseqnum',
]);

function isRetryable(err) {
  const status = err.response?.status ?? err.status;
  if (status) {
    // Non-retriable Stellar transaction result codes fail immediately
    const txCode = err.response?.data?.extras?.result_codes?.transaction;
    if (txCode && NON_RETRIABLE_TX_CODES.has(txCode)) return false;
    return RETRYABLE_STATUSES.has(status);
  }
  // Network-level errors (ECONNRESET, ETIMEDOUT, etc.) have no status
  return true;
}

function retryAfterMs(err) {
  const retryAfter = err.response?.headers?.['retry-after'];
  if (!retryAfter) return null;
  const parsed = parseFloat(retryAfter);
  if (!isNaN(parsed)) return parsed * 1000;
  const date = Date.parse(retryAfter);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Retry fn with exponential backoff and jitter.
 * Respects Retry-After for HTTP 429 responses.
 *
 * @param {Function} fn
 * @param {{ maxRetries?: number, baseDelay?: number, label?: string }} opts
 */
async function retryWithBackoff(fn, { maxRetries = 3, baseDelay = 500, label = 'Horizon call' } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries || !isRetryable(err)) throw err;

      const status = err.response?.status ?? err.status;
      let delay;
      if (status === 429) {
        delay = retryAfterMs(err) ?? Math.min(baseDelay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100), MAX_DELAY_MS);
      } else {
        delay = Math.min(baseDelay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100), MAX_DELAY_MS);
      }

      logger.warn(`${label} failed, retrying (attempt ${attempt}/${maxRetries})`, {
        errorCode: status ?? err.code,
        delay,
        error: err.message,
      });
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

/** Legacy alias — keeps existing callers working unchanged. */
async function withRetry(fn, { maxAttempts = 3, label = 'Horizon call' } = {}) {
  return retryWithBackoff(fn, { maxRetries: maxAttempts - 1, baseDelay: 1000, label });
}

module.exports = { withRetry, retryWithBackoff };
