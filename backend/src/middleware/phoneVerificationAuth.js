const authMiddleware = require('./auth');
const { verifyPhoneVerificationToken, PHONE_VERIFICATION_PURPOSE } = require('../utils/tokens');

/**
 * BE-197: authentication for POST /auth/verify-phone only.
 *
 * Registration issues no session (email verification comes first), so the
 * register response carries a short-lived `phone_verification_token`. This
 * middleware accepts that token as `Authorization: Bearer <token>`, and
 * otherwise falls back to the normal session check so a logged-in user can
 * still verify their phone.
 *
 * Every other route uses authMiddleware, which rejects purpose-scoped tokens,
 * so this token cannot reach any other endpoint.
 */
module.exports = function phoneVerificationAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    let payload = null;
    try {
      payload = verifyPhoneVerificationToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'Phone verification link expired. Log in to request a new code.',
          code: 'PHONE_VERIFICATION_TOKEN_EXPIRED',
        });
      }
      // Not a phone-verification token: treat it as a normal session below.
    }
    if (payload) {
      req.user = { userId: payload.sub, scope: PHONE_VERIFICATION_PURPOSE };
      return next();
    }
  }
  return authMiddleware(req, res, next);
};
