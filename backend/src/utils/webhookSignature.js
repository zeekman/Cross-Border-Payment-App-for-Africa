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
