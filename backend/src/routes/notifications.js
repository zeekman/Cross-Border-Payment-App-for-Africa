const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const { readLimiter } = require('../middleware/rateLimiter');
const { subscribe, unsubscribe, getSubscriptionHealth } = require('../controllers/notificationController');
const { listNotifications, markAsRead, markAllAsRead, getUnreadCount } = require('../controllers/notificationInboxController');

router.use(authMiddleware);
router.use(readLimiter);

/**
 * @swagger
 * /api/notifications/subscribe:
 *   post:
 *     summary: Subscribe to Web Push notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subscription]
 *             properties:
 *               subscription:
 *                 type: object
 *                 description: PushSubscriptionJSON from the browser Push API
 *     responses:
 *       200:
 *         description: Push subscription saved
 *       400:
 *         description: Invalid push subscription
 */
router.post('/subscribe', subscribe);

/**
 * @swagger
 * /api/notifications/subscription-health:
 *   get:
 *     summary: Check whether the user's push subscription is still active
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription health status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hasSubscription:
 *                   type: boolean
 *                 active:
 *                   type: boolean
 *                 failureCount:
 *                   type: integer
 *                 needsResubscribe:
 *                   type: boolean
 */
router.get('/subscription-health', getSubscriptionHealth);

/**
 * @swagger
 * /api/notifications:
 *   get:
 *     summary: List notifications for the authenticated user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           maximum: 100
 *           default: 20
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: integer
 *         description: Pagination cursor (last notification id)
 *     responses:
 *       200:
 *         description: List of notifications
 */
router.get('/notifications', listNotifications);

/**
 * @swagger
 * /api/notifications/{id}/read:
 *   patch:
 *     summary: Mark a notification as read
 *     tags: [Notifications]
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
 *         description: Notification marked as read
 *       404:
 *         description: Notification not found
 */
router.patch('/notifications/:id/read', markAsRead);

/**
 * @swagger
 * /api/notifications/read-all:
 *   post:
 *     summary: Mark all notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read
 */
router.post('/notifications/read-all', markAllAsRead);

/**
 * @swagger
 * /api/notifications/unread-count:
 *   get:
 *     summary: Get unread notification count for badge
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unread count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:
 *                   type: integer
 */
router.get('/notifications/unread-count', getUnreadCount);

router.delete('/subscribe', unsubscribe);

module.exports = router;
