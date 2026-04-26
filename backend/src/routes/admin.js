const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');
const { getStats, getUsers, getTransactions, getStellarNetworkStats } = require('../controllers/adminController');
const { issueTokens } = require('../controllers/assetController');
const { getStats, getUsers, getTransactions, clawback, approveKYC, revokeKYC } = require('../controllers/adminController');
const { getStats, getUsers, getTransactions, clawback, approveKYC, revokeKYC, setWalletFlags } = require('../controllers/adminController');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);
router.use(isAdmin);

router.get('/stats', getStats);
router.get('/users', getUsers);
router.get('/transactions', getTransactions);
router.get('/stellar-stats', getStellarNetworkStats);
router.post('/assets/issue', issueTokens);

router.post('/clawback',
 *   post:
 *     summary: Clawback an asset from a user account (admin only)
 *     description: >
 *       Regulatory compliance operation. Reclaims a Stellar asset (e.g. USDC)
 *       from a user's account. Requires the asset issuer to have
 *       AUTH_CLAWBACK_ENABLED_FLAG set. All operations are audit-logged.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [from, asset, amount]
 *             properties:
 *               from:
 *                 type: string
 *                 description: Stellar public key of the account to clawback from
 *               asset:
 *                 type: string
 *                 description: Asset code (e.g. USDC)
 *               amount:
 *                 type: string
 *                 description: Amount to clawback
 *               reason:
 *                 type: string
 *                 description: Reason for clawback (fraud, court order, etc.)
 *     responses:
 *       200:
 *         description: Clawback executed
 *       400:
 *         description: Validation error
 *       403:
 *         description: Admin access required
 */
router.post('/clawback',
  [
    body('from')
      .notEmpty().withMessage('from address is required')
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar address');
        return true;
      }),
    body('asset').trim().notEmpty().withMessage('asset is required')
      .isAlphanumeric().isLength({ max: 12 }).withMessage('Invalid asset code'),
    body('amount').notEmpty().withMessage('amount is required')
      .isFloat({ gt: 0 }).withMessage('amount must be greater than 0'),
    body('reason').optional().trim().isLength({ max: 500 }),
  ],
  validate,
  clawback
);

router.post('/kyc/:userId/approve', approveKYC);
router.post('/kyc/:userId/revoke', revokeKYC);

router.post(
  '/wallet/:address/set-flags',
  [
    body('set_flags').optional().isInt({ min: 0, max: 15 }).withMessage('set_flags must be 0–15'),
    body('clear_flags').optional().isInt({ min: 0, max: 15 }).withMessage('clear_flags must be 0–15'),
  ],
  validate,
  setWalletFlags,
);

module.exports = router;
