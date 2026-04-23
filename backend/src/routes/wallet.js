const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { getWallet, getQRCode, getWalletTransactions, listDataEntries, setEntry, deleteEntry } = require('../controllers/walletController');
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
          throw new Error('wallet_address must be a valid Stellar public key');
        }
        return true;
      })
  ],
  validate,
  addContact
);
router.delete('/contacts/:id', deleteContact);

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

module.exports = router;
