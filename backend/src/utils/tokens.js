const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_TTL  = process.env.JWT_EXPIRES_IN  || '15m';
const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL || '7d';

// 7 days in ms — must stay in sync with REFRESH_TOKEN_TTL
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const COOKIE_NAME = 'refreshToken';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: REFRESH_TOKEN_TTL_MS,
  path: '/api/auth',
};

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

/** Generate a cryptographically random opaque refresh token */
function generateRefreshToken() {
  const raw  = crypto.randomBytes(40).toString('hex'); // 80-char hex string
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
};
