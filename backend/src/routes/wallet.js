const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { getWallet, getQRCode, getWalletTransactions, exportKey, upgradeToBusinessAccount, addSigner, removeSigner, listSigners, listTrustlines, addTrustlineHandler, removeTrustlineHandler, mergeWallet } = require('../controllers/walletController');
const { getContacts, addContact, deleteContact } = require('../controllers/contactsController');
const { getStatus } = require('../services/horizonRateLimit');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);

router.get('/balance', getWallet);
router.get('/qr', getQRCode);
router.get('/transactions', getWalletTransactions);
router.post('/export-key',
  [body('password').notEmpty().withMessage('Password is required')],
  validate,
  exportKey
);
router.get('/contacts', getContacts);
router.post('/contacts',
  [
    body('name').trim().notEmpty().withMessage('Name is required')
      .isLength({ min: 1, max: 100 }).withMessage('Name must be between 1 and 100 characters'),
    body('wallet_address').notEmpty().withMessage('Wallet address is required')
      .custom((value) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(value)) throw new Error('Invalid Stellar wallet address');
        return true;
      }),
    body('notes').optional({ nullable: true }).isLength({ max: 500 }).withMessage('Notes max 500 characters'),
    body('memo_required').optional().isBoolean().withMessage('memo_required must be boolean'),
    body('default_memo').optional({ nullable: true }).isLength({ max: 64 }).withMessage('default_memo max 64 characters'),
    body('tags').optional().isArray().withMessage('tags must be an array')
      .custom(arr => arr.every(t => typeof t === 'string' && t.length <= 50)).withMessage('Each tag must be a string ≤ 50 chars'),
  ],
  validate,
  addContact
);
router.delete('/contacts/:id', deleteContact);

// Trustline routes
router.get('/trustlines', listTrustlines);
router.post('/trustline',
  [
    body('asset').trim().notEmpty().withMessage('asset is required')
      .isAlphanumeric().isLength({ max: 12 }).withMessage('Invalid asset code'),
    body('limit').optional().isFloat({ min: 0 }).withMessage('limit must be a non-negative number'),
  ],
  validate,
  addTrustlineHandler
);
router.delete('/trustline/:asset',
  [param('asset').isAlphanumeric().isLength({ max: 12 }).withMessage('Invalid asset code')],
  validate,
  removeTrustlineHandler
);

// Account merge — irreversible, closes source account
router.post('/merge',
  [
    body('destination')
      .notEmpty().withMessage('Destination address is required')
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar destination address');
        return true;
      }),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  mergeWallet
);

// Multisig / business account routes
router.post('/upgrade-business', upgradeToBusinessAccount);
router.get('/signers', listSigners);
router.post('/signers',
  [
    body('signer_public_key')
      .notEmpty().withMessage('signer_public_key is required')
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar public key');
        return true;
      }),
    body('label').optional().trim().isLength({ max: 100 }),
  ],
  validate,
  addSigner
);
router.delete('/signers/:signer_public_key',
  [
    param('signer_public_key').custom((v) => {
      if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar public key');
      return true;
    }),
  ],
  validate,
  removeSigner
);

module.exports = router;
