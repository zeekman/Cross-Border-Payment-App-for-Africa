const router = require("express").Router();
const { body, param, validationResult } = require("express-validator");
const StellarSdk = require("@stellar/stellar-sdk");
const authMiddleware = require("../middleware/auth");
const isAdmin = require("../middleware/isAdmin");
const {
  open,
  submitEvidenceHandler,
  resolve,
  getDispute,
  listDisputes,
} = require("../controllers/disputeResolutionController");

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

/**
 * @swagger
 * /api/disputes:
 *   post:
 *     summary: Open a dispute for a payment
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [recipient_wallet, amount]
 *             properties:
 *               recipient_wallet:
 *                 type: string
 *               amount:
 *                 type: number
 *               asset:
 *                 type: string
 *                 enum: [USDC]
 *               support_ticket_id:
 *                 type: integer
 *               escrow_id:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       201:
 *         description: Dispute opened
 */
router.post(
  "/",
  [
    body("recipient_wallet").notEmpty().custom(isValidAddress),
    body("amount").isFloat({ gt: 0 }).withMessage("Amount must be greater than 0"),
    body("asset").optional().isIn(["USDC"]).withMessage("Only USDC is supported"),
    body("support_ticket_id").optional().isInt({ min: 1 }),
    body("escrow_id").optional().isUUID(),
  ],
  validate,
  open
);

/**
 * @swagger
 * /api/disputes/{id}/evidence:
 *   post:
 *     summary: Submit evidence for a dispute
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  "/:id/evidence",
  [
    param("id").isUUID().withMessage("Invalid dispute ID"),
    body("evidence")
      .trim()
      .notEmpty()
      .withMessage("evidence is required")
      .isLength({ max: 256 })
      .withMessage("evidence must be 256 characters or fewer"),
  ],
  validate,
  submitEvidenceHandler
);

/**
 * @swagger
 * /api/disputes/{id}/resolve:
 *   post:
 *     summary: Resolve a dispute (arbitrator/admin only)
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  "/:id/resolve",
  isAdmin,
  [
    param("id").isUUID().withMessage("Invalid dispute ID"),
    body("release_to_recipient")
      .isBoolean()
      .withMessage("release_to_recipient must be a boolean"),
  ],
  validate,
  resolve
);

/**
 * @swagger
 * /api/disputes/{id}:
 *   get:
 *     summary: Get a dispute by ID
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 */
router.get(
  "/:id",
  [param("id").isUUID().withMessage("Invalid dispute ID")],
  validate,
  getDispute
);

/**
 * @swagger
 * /api/disputes:
 *   get:
 *     summary: List disputes for the authenticated user
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 */
router.get("/", listDisputes);

module.exports = router;
