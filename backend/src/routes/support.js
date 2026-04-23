const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const { createTicket, listTickets } = require('../controllers/supportController');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);

/**
 * @swagger
 * /api/support/tickets:
 *   post:
 *     summary: Create a support ticket
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, description]
 *             properties:
 *               transaction_id:
 *                 type: integer
 *               type:
 *                 type: string
 *                 enum: [wrong_address, wrong_amount, failed_deducted, other]
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Ticket created
 *   get:
 *     summary: List user's support tickets
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of tickets
 */
router.post('/tickets',
  [
    body('type').notEmpty().withMessage('type is required'),
    body('description').trim().notEmpty().withMessage('description is required')
      .isLength({ max: 2000 }).withMessage('description must be under 2000 characters'),
    body('transaction_id').optional().isInt({ min: 1 }).withMessage('transaction_id must be a positive integer'),
  ],
  validate,
  createTicket
);

router.get('/tickets', listTickets);

module.exports = router;
