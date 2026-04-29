/**
 * Minimal Web Push sender using only Node.js built-ins.
 *
 * Implements VAPID authentication (RFC 8292) and AES-128-GCM payload
 * encryption (RFC 8291) without any external dependencies.
 *
 * Supports the `aes128gcm` content encoding required by modern browsers.
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');
const url    = require('url');

// ---------------------------------------------------------------------------
// VAPID helpers
// ---------------------------------------------------------------------------

let _vapidKeys = null;

/**
 * Call once at startup with your VAPID credentials.
 * @param {string} subject  - mailto: or https: URI identifying the sender
 * @param {string} publicKey  - URL-safe base64 VAPID public key
 * @param {string} privateKey - URL-safe base64 VAPID private key
 */
function setVapidDetails(subject, publicKey, privateKey) {
  _vapidKeys = { subject, publicKey, privateKey };
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64UrlDecode(str) {
  const pad = (4 - (str.length % 4)) % 4;
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64');
}

/**
 * Build a VAPID Authorization header value.
 */
function buildVapidAuthHeader(audience) {
  if (!_vapidKeys) throw new Error('VAPID details not set. Call setVapidDetails() first.');

  const { subject, publicKey, privateKey } = _vapidKeys;

  const header  = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject }));

  const signingInput = `${header}.${payload}`;
  const privKeyDer   = base64UrlDecode(privateKey);

  // Import as raw EC private key (32 bytes) → DER PKCS#8
  const pkcs8 = ecRawToPkcs8(privKeyDer);
  const keyObj = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });

  const sig = crypto.sign('SHA256', Buffer.from(signingInput), { key: keyObj, dsaEncoding: 'ieee-p1363' });

  const jwt = `${signingInput}.${base64UrlEncode(sig)}`;
  return `vapid t=${jwt},k=${publicKey}`;
}

/**
 * Convert a raw 32-byte EC private key to PKCS#8 DER for P-256.
 */
function ecRawToPkcs8(rawPriv) {
  // PKCS#8 wrapper for P-256 (OID 1.2.840.10045.3.1.7)
  const prefix = Buffer.from(
    '308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420',
    'hex'
  );
  const suffix = Buffer.from('a144034200', 'hex');
  // We need the public key too — derive it
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(rawPriv);
  const pubKey = ecdh.getPublicKey(); // 65 bytes uncompressed

  return Buffer.concat([prefix, rawPriv, suffix, pubKey]);
}

// ---------------------------------------------------------------------------
// Payload encryption (RFC 8291, aes128gcm)
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext payload for delivery to a push subscription.
 * Returns { ciphertext, salt, serverPublicKey }.
 */
function encryptPayload(subscription, plaintext) {
  const { p256dh, auth } = subscription.keys;

  const receiverPub = base64UrlDecode(p256dh);   // 65-byte uncompressed EC point
  const authSecret  = base64UrlDecode(auth);       // 16-byte auth secret

  // Generate ephemeral sender key pair
  const senderECDH = crypto.createECDH('prime256v1');
  senderECDH.generateKeys();
  const senderPub  = senderECDH.getPublicKey();   // 65 bytes

  // ECDH shared secret
  const sharedSecret = senderECDH.computeSecret(receiverPub);

  // Random 16-byte salt
  const salt = crypto.randomBytes(16);

  // HKDF to derive content encryption key and nonce (RFC 8291 §3.3)
  const prk = hkdf(authSecret, sharedSecret, buildInfo('auth', Buffer.alloc(0), Buffer.alloc(0)), 32);
  const cek = hkdf(salt, prk, buildInfo('aesgcm128', receiverPub, senderPub), 16);
  const nonce = hkdf(salt, prk, buildInfo('nonce', receiverPub, senderPub), 12);

  // Pad + encrypt
  const paddedPlaintext = Buffer.concat([Buffer.alloc(2), Buffer.from(plaintext)]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
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

function uint16BE(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const t   = crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return t.slice(0, length);
}

// ---------------------------------------------------------------------------
// Send notification
// ---------------------------------------------------------------------------

/**
 * Send a Web Push notification.
 * @param {object} subscription - PushSubscription JSON { endpoint, keys: { p256dh, auth } }
 * @param {string} payload      - JSON string to send
 * @returns {Promise<number>}   - HTTP status code
 */
function sendNotification(subscription, payload) {
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
        'Authorization':      authHeader,
        'Content-Type':       'application/octet-stream',
        'Content-Encoding':   'aesgcm',
        'Content-Length':     body.length,
        'Encryption':         `salt=${base64UrlEncode(salt)}`,
        'Crypto-Key':         `dh=${base64UrlEncode(serverPublicKey)};p256ecdsa=${_vapidKeys.publicKey}`,
        'TTL':                '86400',
      },
    };

    const req = https.request(options, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve(res.statusCode);
      } else {
        const err = new Error(`Push failed: HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        reject(err);
      }
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { setVapidDetails, sendNotification };
