const express = require('express');
const { body, param, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const { create, list, withdraw, getWithdrawQuote } = require('../controllers/savingsController');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(auth);

/**
 * @swagger
 * /api/savings:
 *   post:
 *     summary: Create a new savings vault
 *     tags: [Savings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, lock_period_days]
 *             properties:
 *               amount:
 *                 type: number
 *               asset:
 *                 type: string
 *                 default: XLM
 *               lock_period_days:
 *                 type: integer
 *                 enum: [7, 30, 90, 180, 365]
 *     responses:
 *       201:
 *         description: Savings vault created
 */
router.post(
  '/',
  [
    body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
    body('asset').optional().isString().isLength({ max: 12 }),
    body('lock_period_days')
      .isInt({ min: 1 })
      .custom((val) => [7, 30, 90, 180, 365].includes(parseInt(val)))
      .withMessage('Invalid lock period'),
  ],
  validate,
  create
);

router.get('/', list);

/**
 * @swagger
 * /api/savings/{id}/withdraw-quote:
 *   get:
 *     summary: Get the exact early-withdrawal penalty for a vault before confirming withdrawal
 *     tags: [Savings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Withdrawal quote
 *       404:
 *         description: Vault not found
 */
router.get(
  '/:id/withdraw-quote',
  [
    param('id').isUUID().withMessage('Invalid vault ID'),
  ],
  validate,
  getWithdrawQuote
);

router.post(
  '/:id/withdraw',
  [
    param('id').isUUID().withMessage('Invalid vault ID'),
  ],
  validate,
  withdraw
);

module.exports = router;
