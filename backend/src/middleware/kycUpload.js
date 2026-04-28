const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// Store outside web root: uploads/ at project root, not inside src/
const storage = multer.diskStorage({
  destination: path.resolve(__dirname, "../../../uploads/kyc"),
  filename: (_req, _file, cb) => {
    const ext = { "image/jpeg": ".jpg", "image/png": ".png", "application/pdf": ".pdf" };
    cb(null, uuidv4() + ext[_file.mimetype]);
  },
});

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error("Only JPEG, PNG, and PDF files are allowed"), { status: 400 }));
  }
};

module.exports = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } }).single(
  "document",
);
