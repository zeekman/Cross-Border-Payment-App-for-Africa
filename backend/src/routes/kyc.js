const router = require("express").Router();
const multer = require("multer");
const { body, validationResult } = require("express-validator");
const authMiddleware = require("../middleware/auth");
const kycUpload = require("../middleware/kycUpload");
const { submitKYC, getKYCStatus } = require("../controllers/kycController");

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// Wrap multer so its errors surface as 400 responses instead of 500s
const upload = (req, res, next) => {
  kycUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File size must not exceed 10 MB" });
    }
    return res.status(400).json({ error: err.message || "File upload error" });
  });
};

router.use(authMiddleware);

router.get("/status", getKYCStatus);

router.post(
  "/submit",
  upload,
  [
    body("id_type").notEmpty().withMessage("ID type is required"),
    body("id_number").notEmpty().withMessage("ID number is required"),
    body("date_of_birth").isISO8601().withMessage("Date of birth must be a valid date"),
  ],
  validate,
  submitKYC,
);

module.exports = router;
