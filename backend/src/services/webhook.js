const crypto = require('crypto');
const https = require('https');
const db = require('../db');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 3;

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
