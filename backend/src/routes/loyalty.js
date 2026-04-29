const router = require("express").Router();
const authMiddleware = require("../middleware/auth");
const { balance, redeem, history } = require("../controllers/loyaltyController");

router.use(authMiddleware);

/**
 * @swagger
 * /api/loyalty/balance:
 *   get:
 *     summary: Get on-chain loyalty point balance
 *     tags: [Loyalty]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current ALP balance
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallet:
 *                   type: string
 *                 points:
 *                   type: integer
 */
router.get("/balance", balance);

/**
 * @swagger
 * /api/loyalty/redeem:
 *   post:
 *     summary: Redeem 100 loyalty points for a 50% fee discount
 *     tags: [Loyalty]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Redemption successful
 *       400:
 *         description: Insufficient points
 */
router.post("/redeem", redeem);

/**
 * @swagger
 * /api/loyalty/history:
 *   get:
 *     summary: Get loyalty point mint/burn history
 *     tags: [Loyalty]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of loyalty events
 */
router.get("/history", history);

module.exports = router;
