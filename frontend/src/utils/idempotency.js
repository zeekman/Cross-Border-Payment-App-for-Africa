import api from './api';

/**
 * Holds one Idempotency-Key per user-confirmed submission (FE-176). The key is
 * reused across retries (e.g. after a timeout) until `reset()` is called on
 * success or on a definitive server response.
 */
export function createIdempotencyKey() {
  let key = null;
  return {
    get() { return (key ||= crypto.randomUUID()); },
    reset() { key = null; },
    /** Reset unless the failure was a lost response (timeout / network error). */
    resetUnlessLost(err) { if (err?.response) key = null; },
  };
}

export function postWithIdempotency(url, body, key, config = {}) {
  return api.post(url, body, {
    ...config,
    headers: { ...config.headers, 'Idempotency-Key': key },
  });
}
