/**
 * Web Push sender with retry queue (Redis) and dead-letter support.
 *
 * Implements VAPID + AES-128-GCM without external dependencies.
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');
const url    = require('url');
const cache  = require('../utils/cache');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RETRY_QUEUE_KEY   = 'push:retry_queue';
const DEAD_LETTER_KEY   = 'push:dead_letter';
const MAX_ATTEMPTS      = 3;
// Retry delays in seconds: attempt 1 → 60s, attempt 2 → 300s, attempt 3 → 1800s
const RETRY_DELAYS      = [60, 300, 1800];
// Consecutive non-permanent failures (across attempts + retries) after which
// a subscription is deactivated even without ever getting a 410/404.
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.PUSH_MAX_CONSECUTIVE_FAILURES || '5', 10);

// ---------------------------------------------------------------------------
// VAPID helpers
// ---------------------------------------------------------------------------
let _vapidKeys = null;

function setVapidDetails(subject, publicKey, privateKey) {
  _vapidKeys = { subject, publicKey, privateKey };
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecode(str) {
  const pad = (4 - (str.length % 4)) % 4;
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64');
}

function buildVapidAuthHeader(audience) {
  if (!_vapidKeys) throw new Error('VAPID details not set. Call setVapidDetails() first.');
  const { subject, publicKey, privateKey } = _vapidKeys;
  const header  = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject }));
  const signingInput = `${header}.${payload}`;
  const privKeyDer   = base64UrlDecode(privateKey);
  const pkcs8 = ecRawToPkcs8(privKeyDer);
  const keyObj = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), { key: keyObj, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${base64UrlEncode(sig)},k=${publicKey}`;
}

function ecRawToPkcs8(rawPriv) {
  const prefix = Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420', 'hex');
  const suffix = Buffer.from('a144034200', 'hex');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(rawPriv);
  const pubKey = ecdh.getPublicKey();
  return Buffer.concat([prefix, rawPriv, suffix, pubKey]);
}

// ---------------------------------------------------------------------------
// Payload encryption (RFC 8291, aes128gcm)
// ---------------------------------------------------------------------------
function encryptPayload(subscription, plaintext) {
  const { p256dh, auth } = subscription.keys;
  const receiverPub = base64UrlDecode(p256dh);
  const authSecret  = base64UrlDecode(auth);
  const senderECDH  = crypto.createECDH('prime256v1');
  senderECDH.generateKeys();
  const senderPub    = senderECDH.getPublicKey();
  const sharedSecret = senderECDH.computeSecret(receiverPub);
  const salt         = crypto.randomBytes(16);
  const prk  = hkdf(authSecret, sharedSecret, buildInfo('auth', Buffer.alloc(0), Buffer.alloc(0)), 32);
  const cek  = hkdf(salt, prk, buildInfo('aesgcm128', receiverPub, senderPub), 16);
  const nonce = hkdf(salt, prk, buildInfo('nonce', receiverPub, senderPub), 12);
  const paddedPlaintext = Buffer.concat([Buffer.alloc(2), Buffer.from(plaintext)]);
  const cipher    = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(paddedPlaintext), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: encrypted, salt, serverPublicKey: senderPub };
}

function buildInfo(type, receiverPub, senderPub) {
  return Buffer.concat([
    Buffer.from(`Content-Encoding: ${type}\0`, 'utf8'),
    Buffer.from('P-256\0', 'utf8'),
    uint16BE(receiverPub.length), receiverPub,
    uint16BE(senderPub.length),   senderPub,
  ]);
}

function uint16BE(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }

function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const t   = crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return t.slice(0, length);
}

// ---------------------------------------------------------------------------
// Low-level send (returns status code, throws on non-2xx)
// ---------------------------------------------------------------------------
function _sendRaw(subscription, payload) {
  return new Promise((resolve, reject) => {
    const endpoint = subscription.endpoint;
    const parsed   = new url.URL(endpoint);
    const audience = `${parsed.protocol}//${parsed.host}`;
    const { ciphertext, salt, serverPublicKey } = encryptPayload(subscription, payload);
    const authHeader = buildVapidAuthHeader(audience);
    const body = ciphertext;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Authorization':    authHeader,
        'Content-Type':     'application/octet-stream',
        'Content-Encoding': 'aesgcm',
        'Content-Length':   body.length,
        'Encryption':       `salt=${base64UrlEncode(salt)}`,
        'Crypto-Key':       `dh=${base64UrlEncode(serverPublicKey)};p256ecdsa=${_vapidKeys.publicKey}`,
        'TTL':              '86400',
      },
    };
    const req = https.request(options, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.statusCode);
      const err = new Error(`Push failed: HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.retryAfter = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
      reject(err);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Subscription health tracking
// ---------------------------------------------------------------------------

/**
 * Deactivate (not delete) a subscription — keeps the stored PushSubscription
 * JSON so we retain history, but stops further send attempts until the user
 * re-subscribes (see notificationController.getSubscriptionHealth).
 */
async function deactivateSubscription(dbPool, subscriptionId) {
  if (!dbPool || !subscriptionId) return;
  await dbPool.query(
    'UPDATE users SET push_subscription_active = false WHERE id = $1',
    [subscriptionId],
  ).catch(e => logger.warn('Failed to deactivate stale push subscription', { error: e.message }));
}

async function recordSendSuccess(dbPool, subscriptionId) {
  if (!dbPool || !subscriptionId) return;
  await dbPool.query(
    'UPDATE users SET push_failure_count = 0, push_subscription_active = true WHERE id = $1',
    [subscriptionId],
  ).catch(e => logger.warn('Failed to reset push failure count', { error: e.message }));
}

/**
 * Increment the consecutive-failure counter and deactivate the subscription
 * once it crosses MAX_CONSECUTIVE_FAILURES.
 */
async function recordSendFailure(dbPool, subscriptionId) {
  if (!dbPool || !subscriptionId) return;
  const result = await dbPool.query(
    `UPDATE users SET push_failure_count = push_failure_count + 1
     WHERE id = $1 RETURNING push_failure_count`,
    [subscriptionId],
  ).catch(e => { logger.warn('Failed to increment push failure count', { error: e.message }); return null; });

  const count = result?.rows?.[0]?.push_failure_count;
  if (count != null && count >= MAX_CONSECUTIVE_FAILURES) {
    await deactivateSubscription(dbPool, subscriptionId);
  }
}

// ---------------------------------------------------------------------------
// Public sendNotification with retry enqueue on failure
// ---------------------------------------------------------------------------

/**
 * Attempt to send; on failure enqueue for retry (unless 410/404 → deactivate).
 * @param {object} subscription - { endpoint, keys }
 * @param {string} payload      - JSON string
 * @param {string|null} subscriptionId - DB id for health tracking / cleanup
 * @param {object} dbPool       - pg pool (optional, passed for health tracking)
 * @returns {Promise<number>}   - HTTP status
 */
async function sendNotification(subscription, payload, subscriptionId = null, dbPool = null) {
  try {
    const status = await module.exports._sendRaw(subscription, payload);
    await recordSendSuccess(dbPool, subscriptionId);
    return status;
  } catch (err) {
    const status = err.statusCode;

    // Permanent failure — deactivate subscription (endpoint is confirmed gone)
    if (status === 410 || status === 404) {
      await deactivateSubscription(dbPool, subscriptionId);
      return status;
    }

    // Enqueue for retry
    if (subscriptionId) {
      await recordSendFailure(dbPool, subscriptionId);
      const retryAfter = (status === 429 && err.retryAfter) ? err.retryAfter : RETRY_DELAYS[0];
      await enqueueRetry({ subscriptionId, subscription, payload, attempt: 1,
        nextRetryAt: Date.now() + retryAfter * 1000 });
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retry queue
// ---------------------------------------------------------------------------

async function enqueueRetry(item) {
  const redis = cache.getClient ? cache.getClient() : null;
  if (!redis) {
    logger.warn('Redis unavailable — push retry not queued', { subscriptionId: item.subscriptionId });
    return;
  }
  await redis.rpush(RETRY_QUEUE_KEY, JSON.stringify(item));
}

/**
 * Process the retry queue. Called by a background job every 60 seconds.
 * @param {object} dbPool - pg pool for 410 cleanup
 */
async function processRetryQueue(dbPool) {
  const redis = cache.getClient ? cache.getClient() : null;
  if (!redis) return;

  const now = Date.now();
  let raw;
  // Process all due items (LPOP loop)
  while ((raw = await redis.lpop(RETRY_QUEUE_KEY)) !== null) {
    let item;
    try { item = JSON.parse(raw); } catch { continue; }

    if (item.nextRetryAt > now) {
      // Not yet due — put back at head and stop processing (preserve order)
      await redis.lpush(RETRY_QUEUE_KEY, raw);
      break;
    }

    try {
      await module.exports._sendRaw(item.subscription, item.payload);
      await recordSendSuccess(dbPool, item.subscriptionId);
      logger.info('Push retry succeeded', { subscriptionId: item.subscriptionId, attempt: item.attempt });
    } catch (err) {
      const status = err.statusCode;

      if (status === 410 || status === 404) {
        // Permanently gone — deactivate (not delete)
        await deactivateSubscription(dbPool, item.subscriptionId);
        continue;
      }

      await recordSendFailure(dbPool, item.subscriptionId);

      if (item.attempt >= MAX_ATTEMPTS) {
        // Move to dead-letter
        logger.warn('Push notification exhausted retries — moving to dead-letter',
          { subscriptionId: item.subscriptionId });
        await redis.rpush(DEAD_LETTER_KEY, JSON.stringify({ ...item, failedAt: Date.now(), error: err.message }));
        continue;
      }

      // Schedule next retry
      const delaySeconds = (status === 429 && err.retryAfter)
        ? err.retryAfter
        : RETRY_DELAYS[item.attempt] || RETRY_DELAYS[MAX_ATTEMPTS - 1];

      await redis.rpush(RETRY_QUEUE_KEY, JSON.stringify({
        ...item,
        attempt: item.attempt + 1,
        nextRetryAt: Date.now() + delaySeconds * 1000,
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// Dead-letter inspection
// ---------------------------------------------------------------------------

async function getDeadLetter() {
  const redis = cache.getClient ? cache.getClient() : null;
  if (!redis) return [];
  const items = await redis.lrange(DEAD_LETTER_KEY, 0, -1);
  return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
}

module.exports = {
  setVapidDetails,
  sendNotification,
  processRetryQueue,
  getDeadLetter,
  deactivateSubscription,
  recordSendSuccess,
  recordSendFailure,
  _sendRaw,
  RETRY_QUEUE_KEY,
  DEAD_LETTER_KEY,
  MAX_ATTEMPTS,
  RETRY_DELAYS,
  MAX_CONSECUTIVE_FAILURES,
};
