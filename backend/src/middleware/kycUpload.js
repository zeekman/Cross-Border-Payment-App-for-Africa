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
const { encryptDocument } = require("../utils/symmetricEncryption");

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const { KYC_UPLOAD_DIR: uploadDir } = require("../utils/kycStorage");
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

    // BE-225: encrypt at rest. The plaintext only exists on disk for the
    // duration of validation/scanning, then is replaced by ciphertext.
    let encryption;
    let sha256;
    try {
      sha256 = await computeSha256(req.file.path);
      const { ciphertext, ...meta } = encryptDocument(await fs.promises.readFile(req.file.path));
      const encPath = `${req.file.path}.enc`;
      await fs.promises.writeFile(encPath, ciphertext, { mode: 0o600 });
      cleanupFile(req.file.path);
      req.file.path = encPath;
      req.file.filename = path.basename(encPath);
      encryption = { algorithm: "aes-256-gcm", ...meta };
    } catch (encErr) {
      cleanupFile(req.file.path);
      return next(encErr);
    }

    // Attach metadata for the controller
    req.kycDocument = {
      path: req.file.path,
      originalName: req.file.originalname,
      sha256Promise: Promise.resolve(sha256),
      encryption,
    };

    next();
  });
}

module.exports = kycUploadMiddleware;
