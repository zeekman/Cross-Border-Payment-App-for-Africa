const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/** Short-lived access token (default 15m). Override with JWT_EXPIRES_IN e.g. "15m". */
const ACCESS_TOKEN_TTL = process.env.JWT_EXPIRES_IN || '15m';

/** Refresh token lifetime in days (default 30). */
const REFRESH_TOKEN_DAYS = Math.max(
  1,
  parseInt(process.env.REFRESH_TOKEN_DAYS || '30', 10) || 30
);
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;

const COOKIE_NAME = 'refreshToken';

const isProduction = process.env.NODE_ENV === 'production';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  // lax allows cross-origin credentialed requests in dev (e.g. localhost:3000 → :5000)
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: REFRESH_TOKEN_TTL_MS,
  path: '/api/auth',
};

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

/** Opaque refresh token; only SHA-256 hash is stored in the database. */
function generateRefreshToken() {
  const raw = crypto.randomBytes(40).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function refreshTokenExpiresAt() {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
}

module.exports = {
  COOKIE_NAME,
  COOKIE_OPTIONS,
  signAccessToken,
  generateRefreshToken,
  refreshTokenExpiresAt,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_DAYS,
};
