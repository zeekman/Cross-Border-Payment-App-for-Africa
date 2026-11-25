/**
 * Webhook Signature
 *
 * HMAC-SHA256 signing/verification for outbound webhook deliveries, shared
 * between services/webhook.js (delivery) and any signature verification
 * paths. Supports a secret-rotation overlap window: a delivery signed while
 * a previous secret is still within its grace period includes both
 * signatures, so a receiver who hasn't rolled their verification key yet
 * still accepts the payload.
 */

const crypto = require('crypto');

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Build the X-AfriPay-Signature-256 header value. Includes a signature per
 * candidate secret, comma-separated, so any verifier holding any one of the
 * secrets can find a match.
 */
function buildSignatureHeader(secrets, payload) {
  return secrets
    .filter(Boolean)
    .map((secret) => `sha256=${sign(secret, payload)}`)
    .join(',');
}

/**
 * Verify a signature header against a set of candidate secrets (e.g. the
 * current secret plus an unexpired previous_secret). Returns true if any
 * candidate produces a matching signature.
 */
function verifySignature(payload, signatureHeader, secrets) {
  if (!signatureHeader) return false;
  const provided = signatureHeader.split(',').map((s) => s.trim().replace(/^sha256=/, ''));

  return secrets.filter(Boolean).some((secret) => {
    const expected = sign(secret, payload);
    return provided.some((sig) => {
      const a = Buffer.from(sig, 'hex');
      const b = Buffer.from(expected, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
  });
}

module.exports = { sign, buildSignatureHeader, verifySignature };
