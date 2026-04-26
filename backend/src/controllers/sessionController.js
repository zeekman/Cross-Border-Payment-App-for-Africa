const crypto = require('crypto');
const db = require('../db');
const logger = require('../utils/logger');

/**
 * Hash a JWT with SHA-256. Raw tokens are never stored.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Record a new session on login.
 * Called from authController.login after issuing the JWT.
 */
async function recordSession(userId, token, req) {
  const tokenHash = hashToken(token);
  const deviceInfo = req.headers['user-agent'] || null;
  const ipAddress = req.ip || req.connection?.remoteAddress || null;

  await db.query(
    `INSERT INTO sessions (user_id, token_hash, device_info, ip_address)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token_hash) DO UPDATE SET last_active = NOW()`,
    [userId, tokenHash, deviceInfo, ipAddress]
  );
}

/**
 * Update last_active for an existing session.
 * Can be called from auth middleware on each request.
 */
async function touchSession(token) {
  const tokenHash = hashToken(token);
  await db.query(
    `UPDATE sessions SET last_active = NOW() WHERE token_hash = $1`,
    [tokenHash]
  ).catch(() => {}); // Non-critical — don't fail the request
}

/**
 * Check if a session token has been revoked.
 * Returns true if the session exists (not revoked), false if revoked.
 */
async function isSessionValid(token) {
  const tokenHash = hashToken(token);
  const { rows } = await db.query(
    `SELECT id FROM sessions WHERE token_hash = $1`,
    [tokenHash]
  );
  return rows.length > 0;
}

/**
 * GET /api/auth/sessions
 * List all active sessions for the authenticated user.
 */
async function listSessions(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, device_info, ip_address, last_active, created_at
       FROM sessions
       WHERE user_id = $1
       ORDER BY last_active DESC`,
      [req.user.userId]
    );

    // Mark the current session
    const currentHash = req.headers.authorization
      ? hashToken(req.headers.authorization.replace('Bearer ', ''))
      : null;

    const sessions = rows.map((s) => ({
      ...s,
      is_current: currentHash
        ? db.query(
            `SELECT 1 FROM sessions WHERE id = $1 AND token_hash = $2`,
            [s.id, currentHash]
          ).then((r) => r.rows.length > 0).catch(() => false)
        : false,
    }));

    // Resolve is_current promises
    const resolved = await Promise.all(
      rows.map(async (s) => {
        let isCurrent = false;
        if (currentHash) {
          const r = await db.query(
            `SELECT 1 FROM sessions WHERE id = $1 AND token_hash = $2`,
            [s.id, currentHash]
          ).catch(() => ({ rows: [] }));
          isCurrent = r.rows.length > 0;
        }
        return { ...s, is_current: isCurrent };
      })
    );

    res.json({ sessions: resolved });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/auth/sessions/:id
 * Revoke a specific session by ID.
 */
async function revokeSession(req, res, next) {
  try {
    const { id } = req.params;
    const { rowCount } = await db.query(
      `DELETE FROM sessions WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    logger.info('Session revoked', { sessionId: id, userId: req.user.userId });
    res.json({ message: 'Session revoked' });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/auth/sessions
 * Revoke all sessions (logout everywhere).
 * Optionally keep the current session alive.
 */
async function revokeAllSessions(req, res, next) {
  try {
    const keepCurrent = req.query.keep_current === 'true';
    const userId = req.user.userId;

    if (keepCurrent && req.headers.authorization) {
      const currentHash = hashToken(req.headers.authorization.replace('Bearer ', ''));
      await db.query(
        `DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2`,
        [userId, currentHash]
      );
    } else {
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    }

    logger.info('All sessions revoked', { userId, keepCurrent });
    res.json({ message: 'All sessions revoked' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  recordSession,
  touchSession,
  isSessionValid,
  listSessions,
  revokeSession,
  revokeAllSessions,
};
