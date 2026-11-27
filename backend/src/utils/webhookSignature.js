const crypto = require('crypto');

const DEFAULT_TOLERANCE_SEC = 300;

function computeSignature(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Build the X-AfriPay-Signature-v2 header: t=<ts>,v1=<sig>[,v1=<sig_prev>] */
function buildHeader(secrets, timestamp, body) {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  return [`t=${timestamp}`, ...list.filter(Boolean).map((s) => `v1=${computeSignature(s, timestamp, body)}`)].join(',');
}

function parseHeader(header) {
  const out = { t: null, v1: [] };
  String(header || '').split(',').forEach((part) => {
    const [k, v] = part.split('=');
    if (k === 't') out.t = parseInt(v, 10);
    else if (k === 'v1' && v) out.v1.push(v);
  });
  return out;
}

function safeEqual(a, b) {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify a v2 signature header. Returns true when any secret matches and the
 * timestamp is within toleranceSec of now.
 */
function verify(header, body, secrets, toleranceSec = DEFAULT_TOLERANCE_SEC) {
  const { t, v1 } = parseHeader(header);
  if (!t || !v1.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const list = Array.isArray(secrets) ? secrets : [secrets];
  return list.filter(Boolean).some((secret) => {
    const expected = computeSignature(secret, t, body);
    return v1.some((sig) => safeEqual(sig, expected));
  });
}

module.exports = { computeSignature, buildHeader, parseHeader, verify, DEFAULT_TOLERANCE_SEC };
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
