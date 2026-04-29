const express = require('express');
const { body, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const { create, list, update, delete: delete_ } = require('../controllers/scheduledPaymentController');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const ONE_MINUTE_MS = 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * @swagger
 * /api/scheduled-payments:
 *   post:
 *     summary: Create a scheduled payment
 *     tags: [Scheduled Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [recipient_wallet, amount, frequency, execute_at]
 *             properties:
 *               recipient_wallet:
 *                 type: string
 *               amount:
 *                 type: number
 *               asset:
 *                 type: string
 *                 enum: [XLM, USDC, NGN, GHS, KES]
 *               frequency:
 *                 type: string
 *                 enum: [daily, weekly, monthly]
 *               execute_at:
 *                 type: string
 *                 format: date-time
 *                 description: Must be at least 1 minute in the future and within 1 year
 *               memo:
 *                 type: string
 *     responses:
 *       200:
 *         description: Scheduled payment created
 *       400:
 *         description: Validation error
 */
router.post(
  '/',
  auth,
  [
    body('execute_at')
      .notEmpty().withMessage('execute_at is required')
      .isISO8601().withMessage('execute_at must be a valid ISO 8601 timestamp')
      .custom((value) => {
        const executeAt = new Date(value);
        const now = Date.now();
        if (executeAt.getTime() < now + ONE_MINUTE_MS) {
          throw new Error('execute_at must be a future timestamp');
        }
        if (executeAt.getTime() > now + ONE_YEAR_MS) {
          throw new Error('execute_at must be within 1 year from now');
        }
        return true;
      }),
  ],
  validate,
  create,
);

router.get('/', auth, list);
router.put('/:id', auth, update);
router.delete('/:id', auth, delete_);

module.exports = router;
