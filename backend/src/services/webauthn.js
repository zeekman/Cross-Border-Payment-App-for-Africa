const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

/**
 * Relying Party config derived from FRONTEND_URL (same origin used for CORS elsewhere).
 * rpID must be the bare hostname (no scheme/port); origin must be the full URL the
 * browser sent the WebAuthn ceremony from.
 */
function getRpConfig() {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const rpID = new URL(frontendUrl).hostname;
  return { rpName: 'AfriPay', rpID, origin: frontendUrl };
}

module.exports = {
  getRpConfig,
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};
