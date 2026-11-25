const fs = require('fs');
const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const { readLimiter } = require('../middleware/rateLimiter');
const supportUpload = require('../middleware/supportUpload');
const { createTicket, listTickets, getAttachment } = require('../controllers/supportController');

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
 *                 type: integer
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
      .optional()
      .isInt({ min: 1 })
      .withMessage('transaction_id must be a positive integer'),
  ],
  validate,
  createTicket
);

router.get('/tickets', listTickets);

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
