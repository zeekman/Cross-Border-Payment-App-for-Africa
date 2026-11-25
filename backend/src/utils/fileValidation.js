const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Magic-byte signatures for supported MIME types.
 * Maps MIME type → array of possible byte-signature arrays.
 */
const MAGIC_SIGNATURES = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png':  [[0x89, 0x50, 0x4E, 0x47]],
  'image/gif':  [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
};

/**
 * Maps MIME types to standard file extensions.
 */
const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

/**
 * Read the first bytes of a file and compare against known magic-byte
 * signatures for the declared MIME type.
 *
 * @param {string} filePath - Absolute path to the uploaded file.
 * @param {string} mimeType - Declared MIME type (e.g. "image/jpeg").
 * @returns {boolean} True if file bytes match at least one signature for the type.
 */
function matchesMagicBytes(filePath, mimeType) {
  const signatures = MAGIC_SIGNATURES[mimeType];
  if (!signatures) return false;

  const maxLen = Math.max(...signatures.map(s => s.length));
  const buf = Buffer.alloc(maxLen);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, maxLen, 0);
  } finally {
    fs.closeSync(fd);
  }

  return signatures.some(sig =>
    sig.every((byte, i) => buf[i] === byte)
  );
}

/**
 * Scan a file with ClamAV (clamscan). If ClamAV is not configured
 * or unavailable, log a warning and skip (return false).
 *
 * @param {string} filePath - Absolute path to the file to scan.
 * @returns {Promise<boolean>} True if the file is infected.
 */
async function tryClamScan(filePath) {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const NodeClam = require('clamscan');
    const scanner = await new NodeClam().init();
    const { isInfected } = await scanner.scanFile(filePath);
    return isInfected;
  } catch {
    logger.warn('ClamAV not configured — skipping malware scan', { filePath });
    return false;
  }
}

/**
 * Compute the SHA-256 hash of a file.
 *
 * @param {string} filePath - Absolute path to the file.
 * @returns {Promise<string>} Hex-encoded SHA-256 digest.
 */
async function computeSha256(filePath) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.pipe(hash).on('finish', () => resolve(hash.read().toString('hex')));
    stream.on('error', reject);
  });
}

/**
 * Delete a single file from disk, swallowing errors.
 *
 * @param {string} filePath - Absolute path to delete.
 */
function cleanupFile(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

/**
 * Delete an array of files from disk, swallowing errors.
 *
 * @param {Array<{path: string}>|null} files - Array of file objects with a `path` property.
 */
function cleanupFiles(files) {
  if (!files) return;
  for (const f of files) {
    cleanupFile(f.path);
  }
}

module.exports = {
  MAGIC_SIGNATURES,
  MIME_EXTENSIONS,
  matchesMagicBytes,
  tryClamScan,
  computeSha256,
  cleanupFile,
  cleanupFiles,
};

