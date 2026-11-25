const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { readLimiter } = require('../middleware/rateLimiter');
const idempotency = require('../middleware/idempotency');
const { buildTransaction, submitSigned } = require('../controllers/ledgerController');

const VALID_ASSETS = ['XLM', 'USDC', 'NGN', 'GHS', 'KES'];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);
router.use(readLimiter);

/**
 * @swagger
 * /api/ledger/build:
 *   post:
 *     summary: Build an unsigned transaction XDR for Ledger hardware wallet signing
 *     tags: [Ledger]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [recipient_address, amount]
 *             properties:
 *               recipient_address:
 *                 type: string
 *                 description: Destination Stellar public key
 *               amount:
 *                 type: number
 *               asset:
 *                 type: string
 *                 enum: [XLM, USDC, NGN, GHS, KES]
 *                 default: XLM
 *               memo:
 *                 type: string
 *               memo_type:
 *                 type: string
 *                 enum: [text, id]
 *                 default: text
 *               wallet_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Unsigned XDR and expiry timestamp
 *       400:
 *         description: Validation error
 */
router.post(
  '/build',
  [
    body('recipient_address')
      .notEmpty().withMessage('recipient_address is required')
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) {
          throw new Error('Invalid Stellar recipient address');
        }
        return true;
      }),
    body('amount')
      .isFloat({ gt: 0 }).withMessage('amount must be greater than 0'),
    body('asset')
      .optional()
      .isIn(VALID_ASSETS).withMessage(`asset must be one of: ${VALID_ASSETS.join(', ')}`),
    body('memo_type')
      .optional()
      .isIn(['text', 'id']).withMessage('memo_type must be text or id'),
  ],
  validate,
  buildTransaction,
);

/**
 * @swagger
 * /api/ledger/submit:
 *   post:
 *     summary: Submit a Ledger-signed transaction XDR to the Stellar network
 *     tags: [Ledger]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [xdr]
 *             properties:
 *               xdr:
 *                 type: string
 *                 description: Signed transaction XDR
 *               recipient_address:
 *                 type: string
 *               amount:
 *                 type: number
 *               asset:
 *                 type: string
 *                 enum: [XLM, USDC, NGN, GHS, KES]
 *               wallet_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Transaction hash and ledger sequence
 *       400:
 *         description: Invalid or unsigned XDR
 */
router.post(
  '/submit',
  [
    body('xdr')
      .notEmpty().withMessage('Signed XDR is required')
      .isString().withMessage('xdr must be a string'),
    body('amount')
      .optional()
      .isFloat({ gt: 0 }).withMessage('amount must be greater than 0'),
    body('asset')
      .optional()
      .isIn(VALID_ASSETS).withMessage(`asset must be one of: ${VALID_ASSETS.join(', ')}`),
  ],
  validate,
  idempotency,
  submitSigned,
);

module.exports = router;
