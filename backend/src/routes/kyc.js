const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");
const authMiddleware = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimiter");
const kycUpload = require("../middleware/kycUpload");
const scanUpload = require("../middleware/scanUpload");
const { submitKYC, getKYCStatus } = require("../controllers/kycController");

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// Rate limiter for KYC submissions — prevents abuse of file upload + AML screening
const kycSubmissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.KYC_SUBMIT_RATE_LIMIT || "5", 10),
  keyGenerator: (req) => req.user.userId,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  message: {
    error: "Too many KYC submissions. You may submit up to 5 per hour.",
  },
});

router.use(authMiddleware);
router.use(readLimiter);

router.get("/status", getKYCStatus);

router.post(
  "/submit",
  kycSubmissionLimiter,
  kycUpload,
  scanUpload,
  [
    body("id_type").notEmpty().withMessage("ID type is required"),
    body("id_number").notEmpty().withMessage("ID number is required"),
    body("date_of_birth").isISO8601().withMessage("Date of birth must be a valid date"),
    body("document_expiry_date").optional().isISO8601().withMessage("Document expiry date must be a valid ISO 8601 date"),
  ],
  validate,
  submitKYC,
);

module.exports = router;
