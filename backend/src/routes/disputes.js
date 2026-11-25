const router = require("express").Router();
const { body, param, validationResult } = require("express-validator");
const StellarSdk = require("@stellar/stellar-sdk");
const authMiddleware = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimiter");
const isAdmin = require("../middleware/isAdmin");
const { disputeEvidenceMiddleware } = require("../middleware/disputeEvidenceUpload");
const {
  open,
  submitEvidenceHandler,
  resolve,
  getDispute,
  listDisputes,
  listEvidence,
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
router.use(readLimiter);

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
 *     summary: Submit evidence for a dispute (file upload or IPFS CID)
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Evidence file (JPEG, PNG, GIF, PDF, max 10 MB)
 *               description:
 *                 type: string
 *                 description: Optional description of evidence
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               evidence:
 *                 type: string
 *                 description: IPFS CID or SHA-256 hash
 *               description:
 *                 type: string
 *                 description: Optional description of evidence
 */
router.post(
  "/:id/evidence",
  [
    param("id").isUUID().withMessage("Invalid dispute ID"),
    body("description").optional().isString().isLength({ max: 500 }),
  ],
  validate,
  disputeEvidenceMiddleware,
  submitEvidenceHandler
);

/**
 * @swagger
 * /api/disputes/{id}/evidence:
 *   get:
 *     summary: List evidence for a dispute
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: List of evidence files
 */
router.get(
  "/:id/evidence",
  [param("id").isUUID().withMessage("Invalid dispute ID")],
  validate,
  listEvidence
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