/**
 * Horizon rate limit tracking and 429 retry logic.
 * Tracks requests in a rolling 1-hour window (3600 req/hr limit).
 */

const HORIZON_LIMIT = 3600;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const WARN_THRESHOLD = 0.8;

// Each entry is a timestamp (ms)
const requestTimestamps = [];

function pruneOldTimestamps() {
  const cutoff = Date.now() - WINDOW_MS;
  while (requestTimestamps.length && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }
}

function recordRequest() {
  pruneOldTimestamps();
  requestTimestamps.push(Date.now());

  const count = requestTimestamps.length;
  if (count >= HORIZON_LIMIT * WARN_THRESHOLD) {
    console.warn(`[Horizon] Rate limit warning: ${count}/${HORIZON_LIMIT} requests used in the last hour`);
  }
}

function getStatus() {
  pruneOldTimestamps();
  const used = requestTimestamps.length;
  return {
    used,
    limit: HORIZON_LIMIT,
    remaining: Math.max(0, HORIZON_LIMIT - used),
    resetInMs: requestTimestamps.length
      ? WINDOW_MS - (Date.now() - requestTimestamps[0])
      : WINDOW_MS,
  };
}

/**
 * Wraps a Horizon call with request tracking and 429 retry.
 * @param {() => Promise<any>} fn
 * @param {number} maxRetries
 */
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    recordRequest();
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status ?? err?.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(err?.response?.headers?.['retry-after'] ?? '5', 10);
        const waitMs = (isNaN(retryAfter) ? 5 : retryAfter) * 1000;
        console.warn(`[Horizon] 429 received. Retrying after ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { withRetry, getStatus, recordRequest };
