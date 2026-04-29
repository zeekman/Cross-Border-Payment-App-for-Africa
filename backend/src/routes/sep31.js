const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { getInfo, createTransaction, getTransaction } = require('../controllers/sep31Controller');
const authMiddleware = require('../middleware/auth');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.get('/info', getInfo);

router.post('/transactions',
  authMiddleware,
  [
    body('amount').isFloat({ gt: 0 }).withMessage('amount must be positive'),
    body('receiver_account').isLength({ min: 56, max: 56 }).withMessage('Invalid receiver account'),
    body('asset_code').optional().isIn(['USDC', 'XLM']).withMessage('Invalid asset code')
  ],
  validate,
  createTransaction
);

router.get('/transactions/:id',
  authMiddleware,
  [
    param('id').isUUID().withMessage('Invalid transaction ID')
  ],
  validate,
  getTransaction
);

module.exports = router;
