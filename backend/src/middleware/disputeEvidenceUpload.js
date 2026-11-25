const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const {
  MIME_EXTENSIONS,
  matchesMagicBytes,
  tryClamScan,
  computeSha256,
  cleanupFile,
} = require('../utils/fileValidation');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function getUploadDir() {
  const baseDir = path.resolve(__dirname, '../../../uploads/disputes');
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  return baseDir;
}

function createStorage(disputeId) {
  const disputeDir = path.join(getUploadDir(), disputeId);
  if (!fs.existsSync(disputeDir)) {
    fs.mkdirSync(disputeDir, { recursive: true });
  }
  return multer.diskStorage({
    destination: disputeDir,
    filename: (_req, file, cb) => {
      const ext = MIME_EXTENSIONS[file.mimetype] || path.extname(file.originalname).toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    },
  });
}

function getUploader(disputeId) {
  const storage = createStorage(disputeId);
  return multer({
    storage,
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(Object.assign(
          new Error('Only JPEG, PNG, GIF, and PDF files are allowed'),
          { status: 400 }
        ));
      }
    },
    limits: { fileSize: MAX_FILE_SIZE },
  }).single('file');
}

function disputeEvidenceMiddleware(req, res, next) {
  const disputeId = req.params.id;
  const upload = getUploader(disputeId);

  upload(req, res, async (err) => {
    if (err) {
      if (req.file) {
        cleanupFile(req.file.path);
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Each file must be 10 MB or smaller' });
      }
      return res.status(400).json({ error: err.message || 'File upload error' });
    }

    if (!req.file) {
      return next();
    }

    if (!matchesMagicBytes(req.file.path, req.file.mimetype)) {
      cleanupFile(req.file.path);
      return res.status(400).json({
        error: `File "${req.file.originalname}" failed content validation — file content does not match declared type`,
      });
    }

    const isInfected = await tryClamScan(req.file.path);
    if (isInfected) {
      cleanupFile(req.file.path);
      return res.status(400).json({
        error: `File "${req.file.originalname}" was rejected by the malware scanner`,
      });
    }

    req.evidenceFile = {
      path: req.file.path,
      originalName: req.file.originalname,
      sha256Promise: computeSha256(req.file.path),
    };

    next();
  });
}

module.exports = { disputeEvidenceMiddleware, computeSha256 };
