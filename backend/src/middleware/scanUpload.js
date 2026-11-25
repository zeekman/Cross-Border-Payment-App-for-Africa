'use strict';
/**
 * Runs an uploaded file (req.file, populated by a prior multer middleware)
 * through the malware scanner before the request is allowed to continue.
 *
 * On a hit, the file is quarantined (moved, not deleted) so support/admin
 * can investigate, and the request is rejected with a generic error.
 * Apply this after any upload middleware built on fileValidation-style
 * MIME/size checks — currently kycUpload.js; wire in future upload
 * pipelines (support attachments, dispute evidence) the same way once they
 * accept raw files.
 */
const fs = require('fs/promises');
const path = require('path');
const { scanBuffer } = require('../utils/malwareScan');
const logger = require('../utils/logger');

async function scanUpload(req, res, next) {
  if (!req.file) return next();

  try {
    const buffer = await fs.readFile(req.file.path);
    const result = await scanBuffer(buffer);

    if (result.clean) return next();

    const quarantineDir = path.resolve(path.dirname(req.file.path), '../quarantine');
    await fs.mkdir(quarantineDir, { recursive: true });
    const quarantinePath = path.join(quarantineDir, path.basename(req.file.path));
    await fs.rename(req.file.path, quarantinePath);

    logger.warn('Uploaded file quarantined: failed malware scan', {
      originalName: req.file.originalname,
      quarantinePath,
      reason: result.reason,
      userId: req.user?.userId,
    });

    return res.status(422).json({ error: 'File failed a security scan and was rejected' });
  } catch (err) {
    next(err);
  }
}

module.exports = scanUpload;
