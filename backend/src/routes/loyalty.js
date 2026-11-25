const router = require("express").Router();
const authMiddleware = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimiter");
const isAdmin = require("../middleware/isAdmin");
const { balance, tiers, redeem, history, mint } = require("../controllers/loyaltyController");

router.use(authMiddleware);
router.use(readLimiter);

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
 * /api/loyalty/tiers:
 *   get:
 *     summary: List loyalty redemption tiers configured on-chain
 *     tags: [Loyalty]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of tiers with threshold and discount_bps
 */
router.get("/tiers", tiers);

/**
 * @swagger
 * /api/loyalty/redeem:
 *   post:
 *     summary: Redeem a loyalty tier for its fee discount
 *     tags: [Loyalty]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tier_index]
 *             properties:
 *               tier_index:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 4
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

/**
 * @swagger
 * /api/loyalty/mint:
 *   post:
 *     summary: Mint loyalty tokens to a user (admin/internal only)
 *     tags: [Loyalty]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_id, points]
 *             properties:
 *               user_id:
 *                 type: string
 *               points:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Tokens minted
 *       400:
 *         description: Invalid input
 *       403:
 *         description: Admin access required
 */
router.post("/mint", isAdmin, mint);

module.exports = router;
