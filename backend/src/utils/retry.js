const logger = require('./logger');

const RETRYABLE_STATUSES = new Set([503, 504]);
const MAX_DELAY_MS = 10_000;

function isRetryable(err) {
  const status = err.response?.status ?? err.status;
  if (status) return RETRYABLE_STATUSES.has(status);
  // Network-level errors (ECONNRESET, ETIMEDOUT, etc.) have no status
  return !status;
}

async function withRetry(fn, { maxAttempts = 3, label = 'Horizon call' } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;

      const delay = Math.min(2 ** (attempt - 1) * 1000, MAX_DELAY_MS);
      logger.warn(`${label} failed, retrying (attempt ${attempt}/${maxAttempts - 1})`, {
        status: err.response?.status,
        delay,
        error: err.message
      });
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

module.exports = { withRetry };
