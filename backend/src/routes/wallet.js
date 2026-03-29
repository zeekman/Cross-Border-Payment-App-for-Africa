const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { getWallet, getQRCode, getWalletTransactions, exportKey, upgradeToBusinessAccount, addSigner, removeSigner, listSigners } = require('../controllers/walletController');
const { getContacts, addContact, deleteContact } = require('../controllers/contactsController');

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
    body('name')
      .trim()
      .notEmpty().withMessage('Name is required')
      .isLength({ min: 1, max: 100 }).withMessage('Name must be between 1 and 100 characters'),
    body('wallet_address')
      .notEmpty().withMessage('Wallet address is required')
      .custom((value) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(value)) {
          throw new Error('Invalid Stellar wallet address');
        }
        return true;
      })
  ],
  validate,
  addContact
);
router.delete('/contacts/:id', deleteContact);

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
