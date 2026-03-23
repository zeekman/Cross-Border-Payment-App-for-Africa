const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { send, history } = require('../controllers/paymentController');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);

router.post('/send',
  [
    body('recipient_address').notEmpty().withMessage('Recipient address is required'),
    body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
    body('asset').optional().isIn(['XLM', 'USDC', 'NGN', 'GHS', 'KES'])
  ],
  validate,
  idempotency,
  send
);

router.get('/history', history);

module.exports = router;
