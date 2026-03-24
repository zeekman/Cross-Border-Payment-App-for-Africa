const router = require("express").Router();
const { body, validationResult } = require("express-validator");
const authMiddleware = require("../middleware/auth");
const { submitKYC, getKYCStatus } = require("../controllers/kycController");

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);

router.get("/status", getKYCStatus);

router.post(
  "/submit",
  [
    body("id_type").notEmpty().withMessage("ID type is required"),
    body("id_number").notEmpty().withMessage("ID number is required"),
    body("date_of_birth").isISO8601().withMessage("Date of birth must be a valid date"),
  ],
  validate,
  submitKYC,
);

module.exports = router;
