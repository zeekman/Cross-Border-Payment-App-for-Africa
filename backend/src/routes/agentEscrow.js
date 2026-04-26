const router = require("express").Router();
const { body, param, validationResult } = require("express-validator");
const StellarSdk = require("@stellar/stellar-sdk");
const authMiddleware = require("../middleware/auth");
const { create, confirm, cancel, getEscrow } = require("../controllers/agentEscrowController");

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

router.use(authMiddleware);

router.post(
  "/create",
  [
    body("agent_wallet").notEmpty().custom(isValidAddress),
    body("recipient_wallet").notEmpty().custom(isValidAddress),
    body("amount").isFloat({ gt: 0 }).withMessage("Amount must be greater than 0"),
    body("asset").optional().isIn(["USDC"]).withMessage("Only USDC is supported for agent escrow"),
  ],
  validate,
  create
);

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
