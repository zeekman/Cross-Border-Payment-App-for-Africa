const DEFAULT_MS = parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS || '3000', 10);

/**
 * Race `promise` against a timer. Rejects with code ETIMEDOUT on timeout.
 * @param {Promise<unknown>} promise
 * @param {number} [ms]
 */
function withTimeout(promise, ms = DEFAULT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout, DEFAULT_MS };
