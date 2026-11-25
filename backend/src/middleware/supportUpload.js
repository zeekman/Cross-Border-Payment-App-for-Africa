const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const {
  MIME_EXTENSIONS,
  matchesMagicBytes,
  tryClamScan,
  cleanupFiles,
} = require('../utils/fileValidation');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES = 3;

const uploadDir = path.resolve(__dirname, '../../../uploads/support');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const ext = MIME_EXTENSIONS[file.mimetype] || path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(Object.assign(
      new Error('Only JPEG, PNG, GIF, and PDF files are allowed'),
      { status: 400 }
    ));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
}).array('attachments', MAX_FILES);

async function supportUploadMiddleware(req, res, next) {
  upload(req, res, async (err) => {
    if (err) {
      cleanupFiles(req.files);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Each file must be 5 MB or smaller' });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'Maximum 3 attachments allowed per ticket' });
      }
      return res.status(400).json({ error: err.message || 'File upload error' });
    }

    if (!req.files || req.files.length === 0) {
      return next();
    }

    for (const file of req.files) {
      if (!matchesMagicBytes(file.path, file.mimetype)) {
        cleanupFiles(req.files);
        return res.status(400).json({
          error: `File "${file.originalname}" failed content validation — file content does not match declared type`,
        });
      }

      const isInfected = await tryClamScan(file.path);
      if (isInfected) {
        cleanupFiles(req.files);
        return res.status(400).json({
          error: `File "${file.originalname}" was rejected by the malware scanner`,
        });
      }
    }

    next();
  });
}

module.exports = supportUploadMiddleware;
