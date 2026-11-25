const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const { decodeXDR } = require('../controllers/toolsController');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

/**
 * @swagger
 * /api/tools/decode-xdr:
 *   post:
 *     summary: Decode a Stellar XDR transaction envelope
 *     tags: [Tools]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [xdr]
 *             properties:
 *               xdr:
 *                 type: string
 *                 description: Base64-encoded Stellar XDR transaction envelope
 *     responses:
 *       200:
 *         description: Decoded transaction object
 *       400:
 *         description: Missing or invalid XDR
 */
router.post(
  '/decode-xdr',
  authMiddleware,
  [
    body('xdr')
      .notEmpty().withMessage('xdr is required')
      .isString().withMessage('xdr must be a string')
      .custom((value) => {
        // Validate it is a non-empty base64 string
        const base64Re = /^[A-Za-z0-9+/]+={0,2}$/;
        if (!base64Re.test(value.trim())) {
          throw new Error('xdr must be a valid base64-encoded XDR string');
        }
        return true;
      }),
  ],
  validate,
  decodeXDR,
);

module.exports = router;
