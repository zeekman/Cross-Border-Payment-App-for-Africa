const crypto = require('crypto');
const db = require('../db');
const logger = require('../utils/logger');
const cache = require('../utils/cache');
const geoip = require('geoip-lite');

const SESSION_CAP = 5;
const TOUCH_DEBOUNCE_SEC = 5 * 60; // 5 minutes

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function detectDeviceType(ua) {
  if (!ua) return 'unknown';
  const s = ua.toLowerCase();
  if (/mobile|android|iphone|ipad/.test(s)) return 'mobile';
  if (/tablet/.test(s)) return 'tablet';
  return 'desktop';
}

function getLocation(ip) {
  if (!ip) return null;
  // Strip IPv6 prefix if present (e.g. ::ffff:1.2.3.4)
  const clean = ip.replace(/^::ffff:/, '');
  const geo = geoip.lookup(clean);
  if (!geo) return null;
  return { city: geo.city || null, country: geo.country || null };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || null;
}

// Blacklist a JTI in Redis so the auth middleware can reject it
async function blacklistJti(jti, ttlSeconds) {
  if (!jti) return;
  await cache.set(`jti:blacklist:${jti}`, 1, ttlSeconds || TOUCH_DEBOUNCE_SEC).catch(() => {});
}

async function isJtiBlacklisted(jti) {
  if (!jti) return false;
  const val = await cache.get(`jti:blacklist:${jti}`).catch(() => null);
  return val !== null;
}

// Record a new session; enforce SESSION_CAP by invalidating the oldest if needed.
async function recordSession(userId, token, req) {
  const tokenHash = hashToken(token);
  const userAgent = req.headers['user-agent'] || null;
  const ipAddress = getClientIp(req);
  const deviceType = detectDeviceType(userAgent);
  const location = getLocation(ipAddress);

  // Extract JTI from decoded token payload (base64 middle section)
  let jti = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    jti = payload.jti || null;
  } catch {}

  // Acquire a dedicated client so BEGIN/COMMIT are scoped to a single connection
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Count active sessions
    const { rows: activeSessions } = await client.query(
      `SELECT id, token_jti, last_active_at
       FROM sessions
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY last_active_at ASC`,
      [userId]
    );

    if (activeSessions.length >= SESSION_CAP) {
      // Invalidate the oldest session
      const oldest = activeSessions[0];
      await client.query(
        `UPDATE sessions SET is_active = FALSE WHERE id = $1`,
        [oldest.id]
      );
      // Blacklist its JTI so it is rejected on next request
      if (oldest.token_jti) {
        await blacklistJti(oldest.token_jti, 24 * 3600);
      }
      logger.info('Session cap reached; oldest session invalidated', {
        userId, invalidatedSessionId: oldest.id,
      });
    }

    await client.query(
      `INSERT INTO sessions
         (user_id, token_hash, token_jti, device_info, device_type, ip_address, location, user_agent, is_active, last_active_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW())
       ON CONFLICT (token_hash) DO UPDATE SET last_active_at = NOW(), is_active = TRUE`,
      [
        userId, tokenHash, jti,
        userAgent, deviceType, ipAddress,
        location ? JSON.stringify(location) : null,
        userAgent,
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Debounced touch: update last_active_at at most once per 5 minutes per token
async function touchSession(token) {
  const tokenHash = hashToken(token);
  const debounceKey = `session:touch:${tokenHash}`;
  const already = await cache.get(debounceKey).catch(() => null);
  if (already) return;
  await cache.set(debounceKey, 1, TOUCH_DEBOUNCE_SEC).catch(() => {});
  await db.query(
    `UPDATE sessions SET last_active_at = NOW() WHERE token_hash = $1 AND is_active = TRUE`,
    [tokenHash]
  ).catch(() => {});
}

async function isSessionValid(token) {
  const tokenHash = hashToken(token);
  const { rows } = await db.query(
    `SELECT id FROM sessions WHERE token_hash = $1 AND is_active = TRUE`,
    [tokenHash]
  );
  return rows.length > 0;
}

// Invalidate all other active sessions for a user (called on password change)
async function invalidateOtherSessions(userId, currentTokenHash) {
  const { rows } = await db.query(
    `UPDATE sessions
     SET is_active = FALSE
     WHERE user_id = $1 AND is_active = TRUE AND token_hash != $2
     RETURNING token_jti`,
    [userId, currentTokenHash]
  );
  for (const row of rows) {
    if (row.token_jti) {
      await blacklistJti(row.token_jti, 24 * 3600);
    }
  }
  logger.info('All other sessions invalidated after password change', { userId });
}

// GET /api/sessions
async function listSessions(req, res, next) {
  try {
    const currentHash = req.headers.authorization
      ? hashToken(req.headers.authorization.replace('Bearer ', ''))
      : null;

    const { rows } = await db.query(
      `SELECT id, device_info, device_type, ip_address, location, user_agent, last_active_at, created_at, token_hash
       FROM sessions
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY last_active_at DESC`,
      [req.user.userId]
    );

    const sessions = rows.map((s) => ({
      id: s.id,
      device_name: s.device_info,
      device_type: s.device_type,
      ip_address: s.ip_address,
      location: s.location,
      last_active_at: s.last_active_at,
      created_at: s.created_at,
      is_current: s.token_hash === currentHash,
    }));

    res.json({ sessions });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/sessions/:id
async function revokeSession(req, res, next) {
  try {
    const { id } = req.params;
    const { rows, rowCount } = await db.query(
      `UPDATE sessions SET is_active = FALSE
       WHERE id = $1 AND user_id = $2 AND is_active = TRUE
       RETURNING token_jti`,
      [id, req.user.userId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const jti = rows[0]?.token_jti;
    if (jti) await blacklistJti(jti, 24 * 3600);

    logger.info('Session revoked', { sessionId: id, userId: req.user.userId });
    res.json({ message: 'Session revoked' });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/sessions  (revoke all sessions)
//
// Safer default (BE-028): the caller's own current session is EXCLUDED by
// default, so "sign out everywhere" does not unexpectedly log the caller
// out of the device they're using to make the request. To also revoke the
// current session (a full "log me out of everything, including this
// device" action), the caller must explicitly pass ?include_current=true.
//
// For backward compatibility, the legacy ?keep_current=true param is still
// honored as a no-op (it's already the default), and ?keep_current=false is
// treated the same as ?include_current=true.
async function revokeAllSessions(req, res, next) {
  try {
    const includeCurrent =
      req.query.include_current === 'true' || req.query.keep_current === 'false';
    const userId = req.user.userId;
    const currentHash = req.headers.authorization
      ? hashToken(req.headers.authorization.replace('Bearer ', ''))
      : null;

    let rows;
    if (!includeCurrent && currentHash) {
      ({ rows } = await db.query(
        `UPDATE sessions SET is_active = FALSE
         WHERE user_id = $1 AND is_active = TRUE AND token_hash != $2
         RETURNING token_jti`,
        [userId, currentHash]
      ));
    } else {
      ({ rows } = await db.query(
        `UPDATE sessions SET is_active = FALSE
         WHERE user_id = $1 AND is_active = TRUE
         RETURNING token_jti`,
        [userId]
      ));
    }

    for (const row of rows) {
      if (row.token_jti) await blacklistJti(row.token_jti, 24 * 3600);
    }

    // Whether the caller's own session was revoked — the frontend needs
    // this to decide whether to force a local logout (see FE-024).
    const currentSessionRevoked = includeCurrent || !currentHash;

    logger.info('All sessions revoked', { userId, includeCurrent, currentSessionRevoked });
    res.json({
      message: currentSessionRevoked
        ? 'All sessions revoked, including this device'
        : 'All other sessions revoked',
      revoked_count: rows.length,
      current_session_revoked: currentSessionRevoked,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  recordSession,
  touchSession,
  isSessionValid,
  isJtiBlacklisted,
  invalidateOtherSessions,
  listSessions,
  revokeSession,
  revokeAllSessions,
};
