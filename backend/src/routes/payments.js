const router = require('express').Router();
const { query, validationResult } = require('express-validator');
const { body, query, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { send, history, findPath, sendPath } = require('../controllers/paymentController');
const { send, history, exportCSV } = require('../controllers/paymentController');
const { send, history } = require('../controllers/paymentController');
const paymentSendValidators = require('../validators/paymentSendValidators');

// Stellar minimum: 1 stroop = 0.0000001 XLM
const STELLAR_MIN = 0.0000001;
// Configurable max per transaction (env var, default 100 000)
const MAX_TX = parseFloat(process.env.MAX_TRANSACTION_AMOUNT || '100000');

/**
 * Reusable amount validator: enforces Stellar minimum and configured maximum.
 */
function amountLimits(field = 'amount') {
  return body(field)
    .isFloat({ gt: 0 }).withMessage('Amount must be greater than 0')
    .custom((v) => {
      const n = parseFloat(v);
      if (n < STELLAR_MIN) {
        throw new Error(`Amount must be at least ${STELLAR_MIN} (1 stroop)`);
      }
      if (n > MAX_TX) {
        throw new Error(`Amount exceeds the maximum allowed per transaction (${MAX_TX})`);
      }
      return true;
    });
}

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);

router.post('/send', paymentSendValidators, validate, idempotency, send);
router.post('/send',
  [
    body('recipient_address')
      .notEmpty().withMessage('Recipient address is required')
      .custom((value) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(value)) {
          throw new Error('Invalid Stellar wallet address');
        }
        return true;
      }),
    amountLimits('amount'),
    body('asset').optional().isIn(['XLM', 'USDC', 'NGN', 'GHS', 'KES']),
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

const VALID_ASSETS = ['XLM', 'USDC', 'NGN', 'GHS', 'KES'];

router.post('/find-path',
  [
    body('source_asset').isIn(VALID_ASSETS).withMessage('Invalid source asset'),
    body('source_amount').isFloat({ gt: 0 }).withMessage('source_amount must be greater than 0'),
    body('destination_asset').isIn(VALID_ASSETS).withMessage('Invalid destination asset'),
    body('recipient_address')
      .notEmpty()
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar wallet address');
        return true;
      }),
  ],
  validate,
  findPath
);

router.post('/send-path',
  [
    body('recipient_address')
      .notEmpty()
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar wallet address');
        return true;
      }),
    body('source_asset').isIn(VALID_ASSETS).withMessage('Invalid source asset'),
    body('source_amount').isFloat({ gt: 0 }).withMessage('source_amount must be greater than 0'),
    body('destination_asset').isIn(VALID_ASSETS).withMessage('Invalid destination asset'),
    body('destination_min_amount').isFloat({ gt: 0 }).withMessage('destination_min_amount must be greater than 0'),
    body('path').optional().isArray(),
  ],
  validate,
  idempotency,
  sendPath
);

module.exports = router;
