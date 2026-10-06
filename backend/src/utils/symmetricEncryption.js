'use strict';

/**
 * OWNERSHIP (BE-039): this module owns ALL server-secret-keyed symmetric
 * encryption — anything deriving its key from an env var
 * (ENCRYPTION_KEY, WEBHOOK_SECRET_ENCRYPTION_KEY) rather than from a
 * counterparty's public key. Currently: AES-256-GCM for webhook secrets and
 * AES-256-CBC for Stellar private keys.
 *
 * It does NOT own asymmetric, per-recipient payload encryption (e.g. memo
 * encryption keyed to a Stellar public key) — that lives in
 * utils/encryption.js. The two modules are intentionally separate: this one
 * has a hard dependency on server-held secrets and must never take a
 * recipient-supplied key as input; utils/encryption.js must never read
 * process.env directly. Keep new AES/HMAC helpers here, not in
 * utils/encryption.js.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// AES-256-GCM — webhook secret encryption (WEBHOOK_SECRET_ENCRYPTION_KEY)
// ---------------------------------------------------------------------------

const GCM_ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function encryptSecret(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(GCM_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: 12-byte IV | 16-byte GCM tag | ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptSecret(ciphertext) {
  const key = getKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(GCM_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// AES-256-CBC — Stellar secret-key encryption (ENCRYPTION_KEY)
//
// deriveAesKey() hashes the raw ENCRYPTION_KEY env var through SHA-256 to
// produce a uniform 32-byte key regardless of the input length or character
// set.  This is safer than truncation (.slice(0,32)) because:
//   - Any input length works (UUID, passphrase, base64 string, …)
//   - All entropy in the original secret is mixed into the derived key
//   - The key space remains uniformly distributed
//
// The same approach is used by channelAccountPool.js (getEncryptionKey()).
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte AES key from ENCRYPTION_KEY via SHA-256.
 *
 * @param {string} [rawKey] - Override; defaults to process.env.ENCRYPTION_KEY.
 *   Pass explicitly in tests to avoid mutating the environment.
 * @returns {Buffer} 32-byte key buffer ready for createCipheriv / createDecipheriv.
 * @throws {Error} if ENCRYPTION_KEY is not set or is shorter than 16 characters.
 */
function deriveAesKey(rawKey) {
  const key = rawKey !== undefined ? rawKey : process.env.ENCRYPTION_KEY;
  if (!key || key.length === 0) {
    throw new Error('ENCRYPTION_KEY is not set. Configure it in your environment.');
  }
  if (key.length < 16) {
    throw new Error(
      `ENCRYPTION_KEY is too short (${key.length} chars). Minimum 16 characters required; 32+ recommended.`,
    );
  }
  return crypto.createHash('sha256').update(key, 'utf8').digest();
}

/**
 * Decrypt an AES-256-CBC ciphertext that was produced with a key derived via
 * deriveAesKey().  The expected ciphertext format is "<iv_hex>:<ciphertext_hex>".
 *
 * @param {string} encryptedValue - "<iv_hex>:<ciphertext_hex>"
 * @param {string} [rawKey]       - Override for ENCRYPTION_KEY (used in tests).
 * @returns {string} Decrypted plaintext.
 */
function decryptAesCbc(encryptedValue, rawKey) {
  const key = deriveAesKey(rawKey);
  const [ivHex, encryptedHex] = encryptedValue.split(':');
  if (!ivHex || !encryptedHex) {
    throw new Error('Invalid encrypted format: expected "<iv_hex>:<ciphertext_hex>"');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(encryptedHex, 'hex', 'utf8') + decipher.final('utf8');
}

/**
 * Encrypt a plaintext string with AES-256-CBC using a key derived from
 * ENCRYPTION_KEY (or the provided rawKey override).
 * Returns "<iv_hex>:<ciphertext_hex>".
 *
 * Used in tests and tooling — production encryption of wallet keys is
 * handled at registration time by authController.js.
 *
 * @param {string} plaintext  - Value to encrypt.
 * @param {string} [rawKey]   - Override for ENCRYPTION_KEY.
 * @returns {string} "<iv_hex>:<ciphertext_hex>"
 */
function encryptAesCbc(plaintext, rawKey) {
  const key = deriveAesKey(rawKey);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

module.exports = {
  // AES-256-GCM (webhook secrets)
  encryptSecret,
  decryptSecret,
  // AES-256-CBC (Stellar private keys)
  deriveAesKey,
  encryptAesCbc,
  decryptAesCbc,
};
