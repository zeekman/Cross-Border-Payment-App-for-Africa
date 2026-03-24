const crypto = require('crypto');
const db = require('../db');

const TTL_HOURS = 24;

function hashBody(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

module.exports = async function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next();

  if (key.length > 255) {
    return res.status(400).json({ error: 'Idempotency-Key must be 255 characters or fewer' });
  }

  const userId = req.user.userId;
  const requestHash = hashBody(req.body);

  // Purge expired keys (best-effort, non-blocking)
  db.query(
    `DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '${TTL_HOURS} hours'`
  ).catch(() => {});

  const existing = await db.query(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1 AND user_id = $2',
    [key, userId]
  ).catch(() => null);

  if (existing?.rows[0]) {
    const cached = existing.rows[0];
    if (cached.request_hash !== requestHash) {
      return res.status(400).json({ error: 'Idempotency-Key reused with different request parameters' });
    }
    // Replay cached response
    return res.status(cached.status_code).json(cached.response);
  }

  // Intercept res.json to cache the response before sending
  const originalJson = res.json.bind(res);
  res.json = async (body) => {
    if (res.statusCode < 500) {
      await db.query(
        `INSERT INTO idempotency_keys (key, user_id, request_hash, status_code, response)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key, user_id) DO NOTHING`,
        [key, userId, requestHash, res.statusCode, JSON.stringify(body)]
      ).catch(() => {});
    }
    return originalJson(body);
  };

  next();
};
