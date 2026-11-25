const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/** Short-lived access token (default 15m). Override with JWT_EXPIRES_IN e.g. "15m". */
const ACCESS_TOKEN_TTL = process.env.JWT_EXPIRES_IN || '15m';

/** Device trust token lifetime: 30 days. */
const DEVICE_TOKEN_TTL = '30d';

/** Refresh token lifetime in days (default 30). */
const REFRESH_TOKEN_DAYS = Math.max(
  1,
  parseInt(process.env.REFRESH_TOKEN_DAYS || '30', 10) || 30
);
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;

const COOKIE_NAME = 'refreshToken';

/** httpOnly cookie carrying the device-trust token (issue #995 — replaces localStorage). */
const DEVICE_COOKIE_NAME = 'deviceTrust';
const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches DEVICE_TOKEN_TTL

const isProduction = process.env.NODE_ENV === 'production';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  // lax allows cross-origin credentialed requests in dev (e.g. localhost:3000 → :5000)
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: REFRESH_TOKEN_TTL_MS,
  path: '/api/auth',
};

const DEVICE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: DEVICE_TOKEN_TTL_MS,
  // Scoped like the refresh-token cookie so /api/auth/login can read it and
  // /api/auth/device-trust can clear it with a matching path.
  path: '/api/auth',
};

function signAccessToken(payload) {
  const jti = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ ...payload, jti }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
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

/** Issue a 30-day device trust token (delivered via an httpOnly cookie — never localStorage). */
function signDeviceToken(payload) {
  return jwt.sign({ ...payload, type: 'device_trust' }, process.env.JWT_SECRET, { expiresIn: DEVICE_TOKEN_TTL });
}

/**
 * Verify a device trust token. Throws if invalid, expired, or wrong type.
 * Returns the decoded payload.
 */
function verifyDeviceToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.type !== 'device_trust') throw new Error('Not a device trust token');
  return payload;
}

module.exports = {
  COOKIE_NAME,
  COOKIE_OPTIONS,
  DEVICE_COOKIE_NAME,
  DEVICE_COOKIE_OPTIONS,
  signAccessToken,
  generateRefreshToken,
  refreshTokenExpiresAt,
  signDeviceToken,
  verifyDeviceToken,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_DAYS,
};
