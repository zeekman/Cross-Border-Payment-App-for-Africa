/**
 * CSRF double-submit cookie middleware, bound to the refresh-token family.
 *
 * The browser automatically sends the httpOnly `refreshToken` cookie on every
 * same-origin AND cross-origin credentialed request, making /auth/refresh and
 * /auth/logout vulnerable to CSRF-based forced token rotation.
 *
 * Defence: on login/refresh the server also sets a non-httpOnly `csrf_token`
 * cookie. JavaScript can read it and must echo it back as the `X-CSRF-Token`
 * request header. A cross-origin attacker cannot read the cookie value, so
 * they cannot forge the header.
 *
 * Plain double-submit is not enough on its own: any valid csrf_token/header
 * pair issued for ANY session would satisfy the equality check, even one
 * belonging to a different user or a different (older, since-rotated)
 * session on the same device. To close that gap the token itself is bound
 * to the refresh-token family it was issued alongside (BE-038):
 *
 *   csrf_token = "<nonce>.<HMAC_SHA256(JWT_SECRET, familyId + ':' + nonce)>"
 *
 * On verification we look up the family_id that the *current* refreshToken
 * cookie belongs to (refresh_tokens.family_id) and recompute the HMAC. A
 * csrf_token minted for a different session/family — even if somehow
 * obtained by an attacker — will fail this check because the family_id
 * won't match, in addition to failing the plain double-submit comparison.
 */
const crypto = require('crypto');
const db = require('../db');
const { COOKIE_NAME } = require('../utils/tokens');

const CSRF_COOKIE = 'csrf_token';

const CSRF_COOKIE_OPTIONS = {
  httpOnly: false,          // must be readable by JS
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — matches refresh token lifetime
};

function csrfSecret() {
  // Reuse JWT_SECRET (already a required, validated env var) rather than
  // introduce a new secret to provision. It is never sent to clients here —
  // only the resulting HMAC is exposed via the cookie.
  return process.env.JWT_SECRET;
}

/** Compute the HMAC-bound CSRF token for a given refresh-token family. */
function signCsrfToken(familyId, nonce = crypto.randomBytes(16).toString('hex')) {
  const mac = crypto
    .createHmac('sha256', csrfSecret())
    .update(`${familyId}:${nonce}`)
    .digest('hex');
  return `${nonce}.${mac}`;
}

/** Verify a CSRF token was minted for the given refresh-token family. */
function verifyCsrfToken(token, familyId) {
  if (!token || typeof token !== 'string' || !familyId) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [nonce, mac] = parts;
  if (!nonce || !mac) return false;

  const expected = signCsrfToken(familyId, nonce).split('.')[1];
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Generate a new CSRF token bound to `familyId` and set it as a readable
 * cookie. `familyId` must be the refresh_tokens.family_id that was just
 * issued or rotated in the same request (login/refresh).
 */
function setCsrfCookie(res, familyId) {
  const token = signCsrfToken(familyId);
  res.cookie(CSRF_COOKIE, token, CSRF_COOKIE_OPTIONS);
  return token;
}

/**
 * Middleware: reject the request unless
 *   1) the X-CSRF-Token header matches the csrf_token cookie (double-submit), and
 *   2) the csrf_token is HMAC-bound to the family of the currently presented
 *      refreshToken cookie (session/family binding — BE-038).
 */
async function verifyCsrf(req, res, next) {
  try {
    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.headers['x-csrf-token'];
    const refreshRaw = req.cookies?.[COOKIE_NAME];

    if (!cookieToken || !headerToken || !refreshRaw) {
      return res.status(403).json({ error: 'CSRF token missing' });
    }

    // Constant-time double-submit comparison to prevent timing attacks
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(headerToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'CSRF token invalid' });
    }

    const hash = crypto.createHash('sha256').update(refreshRaw).digest('hex');
    const result = await db.query(
      'SELECT family_id FROM refresh_tokens WHERE token_hash = $1',
      [hash]
    );
    const familyId = result.rows[0]?.family_id;

    if (!familyId || !verifyCsrfToken(cookieToken, familyId)) {
      return res.status(403).json({ error: 'CSRF token not valid for this session' });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { setCsrfCookie, verifyCsrf, verifyCsrfToken, signCsrfToken, CSRF_COOKIE };
