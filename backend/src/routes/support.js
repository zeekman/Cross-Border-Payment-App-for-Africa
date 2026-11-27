const fs = require('fs');
const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const { readLimiter } = require('../middleware/rateLimiter');
const supportUpload = require('../middleware/supportUpload');
const {
  createTicket,
  listTickets,
  getAttachment,
  getTicket,
  addUserMessage,
  closeTicket,
} = require('../controllers/supportController');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Clean up any uploaded files if body validation fails
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

const ticketCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user.userId,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many support tickets created. You may submit up to 5 tickets per hour.',
  },
});

router.use(authMiddleware);
router.use(readLimiter);

/**
 * @swagger
 * /api/support/tickets:
 *   post:
 *     summary: Create a support ticket (multipart/form-data, up to 3 attachments)
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [type, description]
 *             properties:
 *               transaction_id:
 *                 type: string
 *                 format: uuid
 *                 description: UUID of one of the user's own transactions (any of their wallets)
 *               tx_hash:
 *                 type: string
 *                 description: Alternative to transaction_id — the Stellar transaction hash
 *               type:
 *                 type: string
 *                 enum: [wrong_address, wrong_amount, failed_deducted, other]
 *               description:
 *                 type: string
 *               attachments:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *     responses:
 *       201:
 *         description: Ticket created
 *       404:
 *         description: Transaction not found or does not belong to the user
 *       429:
 *         description: Rate limit exceeded
 *   get:
 *     summary: List user's support tickets
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of tickets
 *
 * /api/support/tickets/{id}:
 *   get:
 *     summary: Get one of the user's tickets with attachments and messages
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Ticket detail
 *       404:
 *         description: Ticket not found (or not owned by the user)
 *
 * /api/support/tickets/{id}/messages:
 *   post:
 *     summary: Reply to one of the user's tickets (reopens a resolved ticket)
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body:
 *                 type: string
 *                 maxLength: 5000
 *     responses:
 *       201:
 *         description: Message added
 *       404:
 *         description: Ticket not found
 *       409:
 *         description: Ticket closed more than 30 days ago
 *
 * /api/support/tickets/{id}/close:
 *   post:
 *     summary: Close one of the user's tickets
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Ticket closed
 *       404:
 *         description: Ticket not found
 *       409:
 *         description: Ticket already closed
 *
 * /api/support/tickets/{id}/attachments/{filename}:
 *   get:
 *     summary: Serve a support ticket attachment
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File content
 *       404:
 *         description: Attachment not found
 */
router.post(
  '/tickets',
  ticketCreationLimiter,
  supportUpload,
  [
    body('type').notEmpty().withMessage('type is required'),
    body('description')
      .trim()
      .notEmpty()
      .withMessage('description is required')
      .isLength({ max: 2000 })
      .withMessage('description must be under 2000 characters'),
    body('transaction_id')
      .optional({ checkFalsy: true })
      .isUUID()
      .withMessage('transaction_id must be a valid UUID'),
    body('tx_hash')
      .optional({ checkFalsy: true })
      .matches(/^[a-f0-9]{64}$/i)
      .withMessage('tx_hash must be a 64-character hex string'),
  ],
  validate,
  createTicket
);

router.get('/tickets', listTickets);

const ticketIdParam = param('id').isInt({ min: 1 }).withMessage('id must be a positive integer');
const messageBody = body('body')
  .trim()
  .notEmpty()
  .withMessage('body is required')
  .isLength({ max: 5000 })
  .withMessage('body must be under 5000 characters');

router.get('/tickets/:id', [ticketIdParam], validate, getTicket);
router.post('/tickets/:id/messages', [ticketIdParam, messageBody], validate, addUserMessage);
router.post('/tickets/:id/close', [ticketIdParam], validate, closeTicket);

router.get(
  '/tickets/:id/attachments/:filename',
  [
    param('id').isInt({ min: 1 }).withMessage('id must be a positive integer'),
    param('filename').notEmpty().withMessage('filename is required'),
  ],
  validate,
  getAttachment
);

module.exports = router;
