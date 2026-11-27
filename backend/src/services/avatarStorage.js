const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const logger = require('../utils/logger');

const STORAGE = (process.env.AVATAR_STORAGE || 'local').toLowerCase();
const LOCAL_DIR = process.env.AVATAR_DIR || path.join(__dirname, '../../uploads/avatars');
const SIZE = 512;

/**
 * Re-encode to a 512x512 WebP. sharp drops all EXIF/GPS/ICC metadata by default,
 * and re-encoding neutralises polyglot files.
 */
function processAvatar(buffer) {
  return sharp(buffer, { failOn: 'error' })
    .rotate() // apply EXIF orientation before metadata is stripped
    .resize(SIZE, SIZE, { fit: 'cover' })
    .webp({ quality: 85 })
    .toBuffer();
}

let s3 = null;
function s3Client() {
  if (s3) return s3;
  // Lazily required so local/dev installs don't need the AWS SDK.
  const { S3Client } = require('@aws-sdk/client-s3');
  s3 = new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
  });
  return s3;
}

/** Store an uploaded image; returns its public URL. File name is random, unrelated to the user id. */
async function saveAvatar(buffer) {
  const data = await processAvatar(buffer);
  const key = `avatars/${crypto.randomUUID()}.webp`;

  if (STORAGE === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: data,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
    const base = process.env.AVATAR_CDN_URL || `https://${process.env.S3_BUCKET}.s3.amazonaws.com`;
    return `${base.replace(/\/$/, '')}/${key}`;
  }

  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_DIR, path.basename(key)), data);
  return `/uploads/${key}`;
}

async function deleteAvatar(url) {
  if (!url) return;
  const name = path.basename(url);
  try {
    if (STORAGE === 's3') {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3Client().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `avatars/${name}` }));
    } else {
      await fs.unlink(path.join(LOCAL_DIR, name));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('Failed to delete old avatar', { error: err.message });
  }
}

module.exports = { processAvatar, saveAvatar, deleteAvatar };
