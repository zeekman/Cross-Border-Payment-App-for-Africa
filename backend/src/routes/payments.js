const router = require('express').Router();
const { query, validationResult, body } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { send, history } = require('../controllers/paymentController');
const { resolveFederationAddress } = require('../services/stellar');
const paymentSendValidators = require('../validators/paymentSendValidators');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);

// Federation address resolution
router.get('/resolve-federation',
  [query('address').notEmpty().withMessage('Address is required')],
  validate,
  async (req, res) => {
    try {
      const publicKey = await resolveFederationAddress(req.query.address);
      res.json({ public_key: publicKey });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  }
);

router.post('/send',
  [
    body('recipient_address')
      .notEmpty().withMessage('Recipient address is required')
      .custom((value) => {
        if (!value.includes('*') && !StellarSdk.StrKey.isValidEd25519PublicKey(value)) {
          throw new Error('Invalid Stellar wallet address or federation address');
        }
        return true;
      }),
    body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
    body('asset').optional().isIn(['XLM', 'USDC', 'NGN', 'GHS', 'KES'])
  ],
  validate,
  idempotency,
  send
);

router.get('/history',
  [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
  ],
  validate,
  history
);

module.exports = router;
