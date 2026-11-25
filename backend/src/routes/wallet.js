const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { requireStepUp } = require('../middleware/requireStepUp');
const { readLimiter, exportKeyLimiter } = require('../middleware/rateLimiter');
const {
  getWallet,
  listWallets,
  createWalletHandler,
  setDefaultWallet,
  getQRCode,
  getWalletTransactions,
  exportKey,
  upgradeToBusinessAccount,
  addSigner,
  removeSigner,
  listSigners,
  getSignersFromHorizon,
  clearInflationDestinationHandler,
  listTrustlines,
  addTrustlineHandler,
  removeTrustlineHandler,
  mergeWallet,
  listDataEntries,
  setEntry,
  deleteEntry,
  getWalletFlags,
  importTransactionHistory,
} = require('../controllers/walletController');
const { getStatus } = require('../services/horizonRateLimit');
const isAdminOrOwner = require('../middleware/isAdminOrOwner');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);
router.use(readLimiter);

// Multi-wallet endpoints
router.get('/list', listWallets);
router.post(
  '/create',
  [body('label').optional().trim().isLength({ max: 100 }).withMessage('Label must be at most 100 characters')],
  validate,
  createWalletHandler,
);
router.put(
  '/default',
  [body('wallet_id').notEmpty().isUUID().withMessage('wallet_id must be a valid UUID')],
  validate,
  setDefaultWallet,
);

// Single-wallet endpoints (support optional ?wallet_id query param)
router.get('/balance', getWallet);
router.get('/qr', getQRCode);

/**
 * @swagger
 * /api/wallet/transactions:
 *   get:
 *     summary: "[REMOVED] Get wallet transactions"
 *     description: >
 *       **Removed** (sunset 2026-01-01). Always responds `410 Gone`.
 *       Use `GET /api/payments/history` instead.
 *     deprecated: true
 *     tags: [Wallet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       410:
 *         description: Endpoint removed; see the `Link` header for the successor
 *       401:
 *         description: Unauthorized
 */
router.get('/transactions', getWalletTransactions);

router.post(
  '/export-key',
  exportKeyLimiter,
  [
    body('password').notEmpty().withMessage('Password is required'),
    body('wallet_id').optional().isUUID().withMessage('wallet_id must be a valid UUID'),
    body('totp_code').optional().trim().isLength({ min: 6, max: 6 }).withMessage('TOTP code must be 6 digits'),
    body('pin').optional().matches(/^\d{4,6}$/).withMessage('PIN must be 4-6 digits'),
  ],
  validate,
  requireStepUp,
  exportKey,
);


// Trustline routes
router.get('/trustlines', listTrustlines);
router.post(
  '/trustline',
  [
    body('asset').trim().notEmpty().withMessage('asset is required').isAlphanumeric().isLength({ max: 12 }).withMessage('Invalid asset code'),
    body('asset_issuer')
      .if(body('asset').not().equals('XLM'))
      .notEmpty().withMessage('asset_issuer is required for non-XLM assets')
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('asset_issuer must be a valid Stellar public key');
        return true;
      }),
    body('limit').optional().isFloat({ min: 0 }).withMessage('limit must be a non-negative number'),
    body('wallet_id').optional().isUUID().withMessage('wallet_id must be a valid UUID'),
  ],
  validate,
  addTrustlineHandler,
);
router.delete(
  '/trustline/:asset',
  [
    param('asset').isAlphanumeric().isLength({ max: 12 }).withMessage('Invalid asset code'),
    query('asset_issuer')
      .optional()
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('asset_issuer must be a valid Stellar public key');
        return true;
      }),
    query('wallet_id').optional().isUUID().withMessage('wallet_id must be a valid UUID'),
  ],
  validate,
  removeTrustlineHandler,
);

// Account merge — irreversible, closes source account
router.post(
  '/merge',
  [
    body('destination')
      .notEmpty()
      .withMessage('Destination address is required')
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar destination address');
        return true;
      }),
    body('password').notEmpty().withMessage('Password is required'),
    body('wallet_id').optional().isUUID().withMessage('wallet_id must be a valid UUID'),
  ],
  validate,
  requireStepUp,
  mergeWallet,
);

// Multisig / business account routes
// NOTE: register each (method, path) pair exactly once in this file — Express uses the
// first matching registration, so a later duplicate is silently dead code. See
// scripts/check-duplicate-routes.js (run in CI) which fails the build on any new duplicate.
router.post(
  '/upgrade-business',
  [body('wallet_id').optional().isUUID().withMessage('wallet_id must be a valid UUID')],
  validate,
  upgradeToBusinessAccount,
);
router.get('/signers', isAdminOrOwner(), listSigners);
router.get('/signers/horizon', getSignersFromHorizon);
router.post('/clear-inflation-destination', clearInflationDestinationHandler);
router.post(
  '/signers',
  isAdminOrOwner(),
  [
    body('signer_public_key')
      .notEmpty()
      .withMessage('signer_public_key is required')
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar public key');
        return true;
      }),
    body('label').optional().trim().isLength({ max: 100 }),
  ],
  validate,
  addSigner,
);
router.delete(
  '/signers/:signer_public_key',
  isAdminOrOwner(),
  [
    param('signer_public_key').custom((v) => {
      if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar public key');
      return true;
    }),
  ],
  validate,
  removeSigner,
);

// Account data entries (manageData) — store arbitrary key-value pairs on the Stellar account
// GET    /api/wallet/data-entries        — list all entries
// POST   /api/wallet/data-entry          — set/update an entry { key, value (≤64 chars) }
// DELETE /api/wallet/data-entry/:key     — delete an entry by key
router.get('/data-entries', listDataEntries);
router.post('/data-entry',
  [
    body('key').trim().notEmpty().withMessage('key is required'),
    body('value').trim().notEmpty().withMessage('value is required')
      .isLength({ max: 64 }).withMessage('value must be 64 characters or fewer'),
  ],
  validate,
  setEntry
);
router.delete('/data-entry/:key', deleteEntry);

// Account authorization flags
router.get('/flags', getWalletFlags);

// Horizon history import
router.post(
  '/import-history',
  [body('wallet_id').optional().isUUID().withMessage('wallet_id must be a valid UUID')],
  validate,
  importTransactionHistory,
);

module.exports = router;
