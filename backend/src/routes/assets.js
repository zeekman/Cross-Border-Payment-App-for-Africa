const router = require('express').Router();
const { getAssetMetadata, getAssetByParams, issueTokens, setAssetStatus } = require('../controllers/assetController');
const { body, param, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');

router.get('/AFRI/info', getAssetMetadata);

/**
 * @openapi
 * /api/assets/{id}/status:
 *   patch:
 *     summary: Enable or disable a supported asset (admin only)
 *     description: >
 *       Toggles supported_assets.is_active and explicitly invalidates the
 *       balance cache (BE-030) so the change takes effect immediately rather
 *       than after the balance cache TTL expires.
 *     tags: [Assets]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Asset status updated
 *       400:
 *         description: Validation error
 *       404:
 *         description: Asset not found
 */
router.patch(
  '/:id/status',
  auth,
  isAdmin,
  [
    param('id').isInt().withMessage('id must be an integer'),
    body('is_active').isBoolean().withMessage('is_active must be a boolean'),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  setAssetStatus
);

router.get('/:code/:issuer', getAssetByParams);

/**
 * @openapi
 * /api/assets/issue:
 *   post:
 *     summary: Issue AFRI tokens to a recipient (admin only)
 *     tags: [Assets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [recipient, amount]
 *             properties:
 *               recipient:
 *                 type: string
 *                 description: Stellar public key of the recipient
 *               amount:
 *                 type: number
 *                 description: Amount of AFRI tokens to issue (must be > 0)
 *     responses:
 *       200:
 *         description: Tokens issued successfully
 *       400:
 *         description: Validation error or issuer keypair not configured
 *       403:
 *         description: Admin access required
 */
router.post(
  '/issue',
  auth,
  isAdmin,
  [
    body('recipient')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('recipient is required'),
    body('amount')
      .isFloat({ gt: 0 })
      .withMessage('amount must be a number greater than 0'),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!process.env.AFRI_ISSUER_PUBLIC || !process.env.AFRI_ISSUER_SECRET) {
      return res.status(400).json({ error: 'AFRI issuer keypair is not configured' });
    }

    next();
  },
  issueTokens
);

module.exports = router;
