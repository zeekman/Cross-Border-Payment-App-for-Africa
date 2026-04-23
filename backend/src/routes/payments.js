const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const paymentSendValidators = require('../validators/paymentSendValidators');
const { send, history, exportCSV, estimateFee } = require('../controllers/paymentController');
const { query, validationResult, body } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { query, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { send, history, findPath, sendPath } = require('../controllers/paymentController');
const { send, history, exportCSV } = require('../controllers/paymentController');
const { send, history } = require('../controllers/paymentController');
const { resolveFederationAddress } = require('../services/stellar');
const { isMemoRequired } = require('../services/memoRequired');
const paymentSendValidators = require('../validators/paymentSendValidators');
const { ALLOWED_HISTORY_ASSETS } = require('../utils/historyQuery');

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

// Stellar minimum payment is 0.0000001 XLM (1 stroop)
const STELLAR_MIN_AMOUNT = 0.0000001;
const MAX_TRANSACTION_AMOUNT = parseFloat(process.env.MAX_TRANSACTION_AMOUNT || '1000000');

router.use(authMiddleware);

router.get('/estimate-fee', estimateFee);

router.post('/send', paymentSendValidators, validate, idempotency, send);
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

// Memo requirement check
router.get('/memo-required',
  [query('address').notEmpty().withMessage('Address is required')],
  validate,
  async (req, res) => {
    try {
      const required = await isMemoRequired(req.query.address);
      res.json({ memo_required: required });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
    body('amount')
      .isFloat({ gt: 0 }).withMessage('Amount must be greater than 0')
      .custom((value) => {
        const amount = parseFloat(value);
        if (amount < STELLAR_MIN_AMOUNT) {
          throw new Error(`Amount must be at least ${STELLAR_MIN_AMOUNT} XLM (1 stroop)`);
        }
        if (amount > MAX_TRANSACTION_AMOUNT) {
          throw new Error(`Amount exceeds maximum transaction limit of ${MAX_TRANSACTION_AMOUNT}`);
        }
        return true;
      }),
    body('asset').optional().isIn(['XLM', 'USDC', 'NGN', 'GHS', 'KES'])
    amountLimits('amount'),
    body('asset').optional().isIn(['XLM', 'USDC', 'NGN', 'GHS', 'KES']),
  ],
  validate,
  idempotency,
  send
);

router.get(
  '/history',
  [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('limit must be between 1 and 100'),
    query('from')
      .optional({ values: 'falsy' })
      .trim()
      .isISO8601()
      .withMessage('from must be a valid ISO 8601 date'),
    query('to')
      .optional({ values: 'falsy' })
      .trim()
      .isISO8601()
      .withMessage('to must be a valid ISO 8601 date'),
    query('asset')
      .optional({ values: 'falsy' })
      .trim()
      .isIn(ALLOWED_HISTORY_ASSETS)
      .withMessage(`asset must be one of: ${ALLOWED_HISTORY_ASSETS.join(', ')}`),
  ],
  validate,
  history
);

router.get('/export', exportCSV);
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
