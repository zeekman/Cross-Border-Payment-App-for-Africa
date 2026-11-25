const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const {
  MIME_EXTENSIONS,
  matchesMagicBytes,
  tryClamScan,
  cleanupFile,
  computeSha256,
} = require("../utils/fileValidation");

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const uploadDir = path.resolve(__dirname, "../../../uploads/kyc");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const ext = MIME_EXTENSIONS[file.mimetype] || ".bin";
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error("Only JPEG, PNG, and PDF files are allowed"), { status: 400 }));
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } }).single(
  "document",
);

/**
 * Multer middleware for KYC document uploads with content-based validation.
 *
 * Validates file content via magic-byte signatures and runs ClamAV malware
 * scanning before accepting the file, consistent with disputeEvidenceUpload
 * and supportUpload middlewares.
 */
function kycUploadMiddleware(req, res, next) {
  upload(req, res, async (err) => {
    if (err) {
      if (req.file) {
        cleanupFile(req.file.path);
      }
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File size must not exceed 10 MB" });
      }
      return res.status(400).json({ error: err.message || "File upload error" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Document file is required" });
    }

    // Content-based magic-byte validation
    if (!matchesMagicBytes(req.file.path, req.file.mimetype)) {
      cleanupFile(req.file.path);
      return res.status(400).json({
        error: `File "${req.file.originalname}" failed content validation — file content does not match declared type`,
      });
    }

    // Malware scan via ClamAV
    const isInfected = await tryClamScan(req.file.path);
    if (isInfected) {
      cleanupFile(req.file.path);
      return res.status(400).json({
        error: `File "${req.file.originalname}" was rejected by the malware scanner`,
      });
    }

    // Attach metadata for the controller
    req.kycDocument = {
      path: req.file.path,
      originalName: req.file.originalname,
      sha256Promise: computeSha256(req.file.path),
    };

    next();
  });
}

module.exports = kycUploadMiddleware;
