const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const { summary } = require('../controllers/analyticsController');

router.use(authMiddleware);

router.get('/summary', summary);
/**
 * @swagger
 * /api/analytics/summary:
 *   get:
 *     summary: Get analytics summary
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Analytics summary returned successfully
 *       401:
 *         description: Unauthorized
 */
router.get('/summary', authMiddleware, summary);

module.exports = router;
