const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const { readLimiter } = require('../middleware/rateLimiter');
const isAdmin = require('../middleware/isAdmin');
const { getStats, getReferralDetails, awardReferralCreditHandler } = require('../controllers/referralController');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);
router.use(readLimiter);

/**
 * @swagger
 * /api/referrals/stats:
 *   get:
 *     summary: Get referral stats for the authenticated user
 *     tags: [Referrals]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Referral code, count, and credit summary
 */
router.get('/stats', getStats);

/**
 * @swagger
 * /api/referrals/details:
 *   get:
 *     summary: Get list of referrals with their reward status
 *     tags: [Referrals]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of referrals with reward status (pending, credited, failed, ineligible)
 */
router.get('/details', getReferralDetails);

/**
 * @swagger
 * /api/referrals/award:
 *   post:
 *     summary: Award referral credit for a referred user's first transaction (admin only)
 *     tags: [Referrals]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [referred_user_id]
 *             properties:
 *               referred_user_id:
 *                 type: string
 *                 description: UUID of the user whose referrer should receive credit
 *     responses:
 *       200:
 *         description: Credit awarded (or silently skipped if already awarded)
 *       400:
 *         description: Missing referred_user_id
 *       403:
 *         description: Admin access required
 */
router.post(
  '/award',
  isAdmin,
  [
    body('referred_user_id')
      .notEmpty().withMessage('referred_user_id is required')
      .isUUID().withMessage('referred_user_id must be a valid UUID'),
  ],
  validate,
  awardReferralCreditHandler,
);

module.exports = router;
