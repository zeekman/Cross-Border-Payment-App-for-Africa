const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { getInfo, createTransaction, getTransaction, updateTransactionStatus } = require('../controllers/sep31Controller');
const authMiddleware = require('../middleware/auth');

/** Runs express-validator results and short-circuits with 400 on failure. */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

/**
 * @openapi
 * /api/sep31/info:
 *   get:
 *     summary: SEP-31 supported assets and required fields
 *     description: >
 *       Returns the list of assets supported for cross-border payments and the
 *       SEP-12 fields required for senders and receivers. Conforms to the
 *       Stellar SEP-31 /info specification.
 *     tags: [SEP-31]
 *     responses:
 *       200:
 *         description: Supported assets and field requirements
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 receive:
 *                   type: object
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       enabled:
 *                         type: boolean
 *                       min_amount:
 *                         type: number
 *                       max_amount:
 *                         type: number
 *                       fee_fixed:
 *                         type: number
 *                       fee_percent:
 *                         type: number
 *                       sep12:
 *                         type: object
 *                       fields:
 *                         type: object
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/info', getInfo);

/**
 * @openapi
 * /api/sep31/transactions:
 *   post:
 *     summary: Initiate a SEP-31 cross-border payment
 *     description: >
 *       Creates a new cross-border payment transaction. The authenticated user
 *       is the sender. KYC status is checked automatically. Required fields are
 *       validated against the anchor's /info schema when reachable.
 *     tags: [SEP-31]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *               - receiver_account
 *             properties:
 *               amount:
 *                 type: number
 *                 description: Payment amount (must be > 0)
 *                 example: 100.00
 *               asset_code:
 *                 type: string
 *                 enum: [USDC, XLM]
 *                 default: USDC
 *                 description: Asset code for the payment
 *               receiver_account:
 *                 type: string
 *                 description: Stellar public key of the receiving account (56 chars)
 *                 example: GBBD47UZQ2BNSE7E2CMPL3XUREV3ZCYY5LMPJCJ7I7ZLIP4UGJLE66V2
 *               sender_name:
 *                 type: string
 *                 description: Full name of the sender (optional)
 *               sender_email:
 *                 type: string
 *                 format: email
 *                 description: Email address of the sender (optional)
 *               fields:
 *                 type: object
 *                 description: >
 *                   Additional transaction fields required by the anchor
 *                   (e.g. receiver_routing_number, type). See /info for details.
 *                 example:
 *                   type: mobile_money
 *     responses:
 *       201:
 *         description: Transaction created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: uuid
 *                 status:
 *                   type: string
 *                   enum: [pending, completed, failed]
 *                 amount:
 *                   type: number
 *                 asset_code:
 *                   type: string
 *                 receiver_account:
 *                   type: string
 *                 kyc_verified:
 *                   type: boolean
 *                 sender_name:
 *                   type: string
 *                   nullable: true
 *                 sender_email:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: Validation error or missing required anchor fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized — missing or invalid JWT
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post(
  '/transactions',
  authMiddleware,
  [
    body('amount')
      .notEmpty().withMessage('amount is required')
      .isFloat({ gt: 0 }).withMessage('amount must be a positive number'),
    body('asset_code')
      .optional()
      .isIn(['USDC', 'XLM']).withMessage('asset_code must be USDC or XLM'),
    body('receiver_account')
      .notEmpty().withMessage('receiver_account is required')
      .isLength({ min: 56, max: 56 }).withMessage('receiver_account must be a 56-character Stellar public key'),
    body('sender_name')
      .optional()
      .isString().withMessage('sender_name must be a string')
      .trim()
      .isLength({ max: 200 }).withMessage('sender_name must be 200 characters or fewer'),
    body('sender_email')
      .optional()
      .isEmail().withMessage('sender_email must be a valid email address')
      .normalizeEmail(),
    body('fields')
      .optional()
      .isObject().withMessage('fields must be an object'),
  ],
  validate,
  createTransaction
);

/**
 * @openapi
 * /api/sep31/transactions/{id}:
 *   get:
 *     summary: Get a SEP-31 transaction by ID
 *     description: >
 *       Returns the current status and details of a SEP-31 cross-border payment
 *       transaction. Only the transaction's sender may retrieve it.
 *     tags: [SEP-31]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: UUID of the SEP-31 transaction
 *     responses:
 *       200:
 *         description: Transaction details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: uuid
 *                 status:
 *                   type: string
 *                   enum: [pending, completed, failed]
 *                 amount:
 *                   type: number
 *                 asset_code:
 *                   type: string
 *                 receiver_account:
 *                   type: string
 *                 kyc_verified:
 *                   type: boolean
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *                 updated_at:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Invalid transaction ID format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized — missing or invalid JWT
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Transaction not found or does not belong to the authenticated user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  '/transactions/:id',
  authMiddleware,
  [
    param('id').isUUID().withMessage('id must be a valid UUID'),
  ],
  validate,
  getTransaction
);

router.patch('/transactions/:id/status',
  authMiddleware,
  [
    param('id').isUUID().withMessage('Invalid transaction ID'),
    body('status').isIn(['pending', 'completed', 'error', 'refunded']).withMessage('Invalid status'),
  ],
  validate,
  updateTransactionStatus
);

module.exports = router;
