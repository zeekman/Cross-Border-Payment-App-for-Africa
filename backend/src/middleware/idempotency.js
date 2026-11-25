const crypto = require('crypto');
const logger = require('../utils/logger');
const cache = require('../utils/cache');
const db = require('../db');

/**
 * Idempotency key TTL and eviction policy (#958):
 *
 * - Every key (Redis + DB) is retained for TTL_HOURS (24h) from creation, matching
 *   common payment-gateway conventions (e.g. Stripe) — long enough to cover client
 *   retries across a lost connection or a slow queue, short enough to bound storage.
 * - Redis is the primary store and expires entries itself via the TTL passed to
 *   cache.set(); this is the fast path for the replay/duplicate checks above.
 * - The `idempotency_keys` DB table is a durable fallback for responses that predate
 *   the Redis layer or survive a Redis flush; it is NOT auto-expired by Postgres.
 *   Instead, on every request with a *new* key, this middleware opportunistically
 *   fires a best-effort `DELETE ... WHERE created_at < NOW() - INTERVAL '24 hours'`
 *   (see the bottom of this file) so the table doesn't grow unbounded. This is
 *   eviction-on-write, not a background job — an idle system will not proactively
 *   purge, but the table only grows when new keys are being written anyway.
 * - A short-lived `idem:inflight:*` marker (IN_FLIGHT_TTL, 30s) guards against two
 *   concurrent requests with the same key racing each other; it is deleted as soon
 *   as the request finishes (success or error) and expires on its own otherwise.
 */
const TTL_HOURS = 24;
const TTL_SECONDS = TTL_HOURS * 60 * 60;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IN_FLIGHT_TTL = 30;

function hashBody(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

module.exports = async function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];

  if (!key) {
    logger.warn('Idempotency-Key header missing — this will be required in a future version', {
      path: req.path,
      method: req.method,
    });
    return next();
  }

  if (!UUID_V4_RE.test(key)) {
    return res.status(400).json({ error: 'Invalid Idempotency-Key format' });
  }

  const userId = req.user.userId;
  const redisKey = `idem:payment:${key}`;
  const inFlightKey = `idem:inflight:${key}`;

  // Compute hash up-front so it can be validated against any cached entry
  const requestHash = hashBody(req.body);

  // Check in-flight marker before doing anything else
  const inFlight = await cache.get(inFlightKey);
  if (inFlight) {
    return res.status(409).json({ error: 'Request in progress' });
  }

  // Check Redis for a cached completed response
  const cached = await cache.get(redisKey);
  if (cached) {
    if (cached.request_hash !== requestHash) {
      return res.status(409).json({ error: 'Idempotency-Key reused with a different request body' });
    }
    res.set('X-Idempotency-Replayed', 'true');
    return res.status(cached.statusCode).json(cached.body);
  }

  // Fall back to DB for responses that predate the Redis layer
  const existing = await db.query(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1 AND user_id = $2',
    [key, userId]
  ).catch(() => null);

  if (existing?.rows[0]) {
    const row = existing.rows[0];
    if (row.request_hash !== requestHash) {
      return res.status(409).json({ error: 'Idempotency-Key reused with a different request body' });
    }
    res.set('X-Idempotency-Replayed', 'true');
    return res.status(row.status_code).json(row.response);
  }

  // Mark request as in-flight so concurrent duplicates get 409
  await cache.set(inFlightKey, '1', IN_FLIGHT_TTL);

  const originalJson = res.json.bind(res);
  res.json = async (body) => {
    await cache.del(inFlightKey);
    if (res.statusCode < 500) {
      await cache.set(redisKey, { statusCode: res.statusCode, body, request_hash: requestHash }, TTL_SECONDS);
      await db.query(
        `INSERT INTO idempotency_keys (key, user_id, request_hash, status_code, response)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key, user_id) DO NOTHING`,
        [key, userId, requestHash, res.statusCode, JSON.stringify(body)]
      ).catch(() => {});
    }
    return originalJson(body);
  };

  // Ensure in-flight marker is cleared even if the handler never calls res.json
  res.on('finish', () => cache.del(inFlightKey).catch(() => {}));

  // Purge expired DB keys (best-effort, non-blocking)
  db.query(
    `DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '${TTL_HOURS} hours'`
  ).catch(() => {});

  next();
};
