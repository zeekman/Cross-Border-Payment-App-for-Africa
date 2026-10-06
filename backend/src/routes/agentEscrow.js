const router = require("express").Router();
const { body, param, query, validationResult } = require("express-validator");
const StellarSdk = require("@stellar/stellar-sdk");
const authMiddleware = require("../middleware/auth");
const idempotency = require("../middleware/idempotency");
const { create, confirm, cancel, getEscrow, listEscrows } = require("../controllers/agentEscrowController");

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const isValidAddress = (v) => {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) {
    throw new Error("Invalid Stellar wallet address");
  }
  return true;
};

// Amount must be a decimal string with at most 7 decimal places (stroop precision).
const isValidAmount = (v) => {
  if (typeof v !== "string" || !/^\d+(\.\d{1,7})?$/.test(v.trim())) {
    throw new Error("Amount must be a decimal string with at most 7 decimal places");
  }
  if (Number(v) <= 0) {
    throw new Error("Amount must be greater than 0");
  }
  return true;
};

router.use(authMiddleware);
router.use(readLimiter);

router.get(
  "/",
  [
    query("role").optional().isIn(["sender", "agent"]).withMessage("role must be sender or agent"),
    query("status").optional().isString(),
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  listEscrows
);

router.post(
  "/create",
  idempotency,
  [
    body("agent_wallet").notEmpty().custom(isValidAddress),
    body("recipient_wallet").notEmpty().custom(isValidAddress),
    body("amount").notEmpty().custom(isValidAmount),
    body("asset").optional().isIn(["USDC"]).withMessage("Only USDC is supported for agent escrow"),
  ],
  validate,
  create
);

router.post(
  "/:id/confirm-payout",
  [param("id").isUUID().withMessage("Invalid escrow ID")],
  validate,
  confirm
);

// Legacy alias kept for backward compatibility
router.post(
  "/:id/confirm",
  [param("id").isUUID().withMessage("Invalid escrow ID")],
  validate,
  confirm
);

router.post(
  "/:id/cancel",
  [param("id").isUUID().withMessage("Invalid escrow ID")],
  validate,
  cancel
);

router.get(
  "/:id",
  [param("id").isUUID().withMessage("Invalid escrow ID")],
  validate,
  getEscrow
);

module.exports = router;
