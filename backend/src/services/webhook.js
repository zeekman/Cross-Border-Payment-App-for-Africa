const crypto = require('crypto');
const https = require('https');
const dns = require('dns').promises;
const db = require('../db');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 3;

// Reuse the same private-IP check as the controller
const BLOCKED_CIDRS = [
  [0x0a000000, 0xff000000],
  [0xac100000, 0xfff00000],
  [0xc0a80000, 0xffff0000],
  [0x7f000000, 0xff000000],
  [0xa9fe0000, 0xffff0000],
  [0x64400000, 0xffc00000],
  [0x00000000, 0xff000000],
  [0xe0000000, 0xf0000000],
  [0xf0000000, 0xf0000000],
];

function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

function isPrivateIp(ip) {
  if (ip === '::1' || ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const n = ipToInt(ip);
  return BLOCKED_CIDRS.some(([net, mask]) => (n & mask) === (net & mask));
}

async function isPublicHttpsUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && isPrivateIp(hostname)) return false;
  try {
    const { address } = await dns.lookup(hostname);
    if (isPrivateIp(address)) return false;
  } catch { return false; }
  return true;
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function httpsPost(url, body, signature) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-AfriPay-Signature': `sha256=${signature}`,
      },
    };
    const req = https.request(options, (res) => {
      res.resume();
      res.statusCode >= 200 && res.statusCode < 300 ? resolve(res.statusCode) : reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function deliverWithRetry(url, secret, payload, attempt = 0) {
  // Re-validate URL before each delivery to catch DNS rebinding / stale records
  if (!await isPublicHttpsUrl(url)) {
    logger.error('Webhook delivery blocked: URL failed SSRF validation', { url });
    return;
  }
  const body = JSON.stringify(payload);
  const signature = sign(secret, body);
  try {
    await httpsPost(url, body, signature);
  } catch (err) {
    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn('Webhook delivery failed, retrying', {
        url,
        attempt: attempt + 1,
        maxAttempts: MAX_ATTEMPTS,
        delay,
        error: err.message,
      });
      await new Promise((r) => setTimeout(r, delay));
      return deliverWithRetry(url, secret, payload, attempt + 1);
    }
    // All attempts exhausted — log a persistent error so operators can investigate
    logger.error('Webhook delivery permanently failed after max retries', {
      url,
      event: payload.event,
      attempts: MAX_ATTEMPTS,
      error: err.message,
    });
  }
}

async function deliver(event, data) {
  const { rows } = await db.query(
    `SELECT url, secret FROM webhooks WHERE active = true AND $1 = ANY(events)`,
    [event]
  );
  const payload = { event, data, timestamp: new Date().toISOString() };
  await Promise.all(rows.map((wh) => deliverWithRetry(wh.url, wh.secret, payload)));
}

module.exports = { deliver, sign, MAX_ATTEMPTS };
