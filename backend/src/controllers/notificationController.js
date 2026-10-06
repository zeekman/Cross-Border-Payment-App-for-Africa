const db = require('../db');
const webpush = require('../services/webpush');
const ledgerListener = require('../services/ledgerListener');
const { persistAndBroadcast } = require('../services/notificationInbox');
const logger = require('../utils/logger');

/**
 * POST /api/notifications/subscribe
 * Body: { subscription: PushSubscriptionJSON }
 */
async function subscribe(req, res, next) {
  try {
    const { subscription } = req.body;
    const errors = [];

    if (!subscription?.endpoint || !/^https:\/\//i.test(subscription.endpoint)) {
      errors.push({ field: 'subscription.endpoint', message: 'endpoint must be a valid HTTPS URL' });
    }
    if (!subscription?.keys?.p256dh || typeof subscription.keys.p256dh !== 'string' || !subscription.keys.p256dh.trim()) {
      errors.push({ field: 'subscription.keys.p256dh', message: 'keys.p256dh must be a non-empty string' });
    }
    if (!subscription?.keys?.auth || typeof subscription.keys.auth !== 'string' || !subscription.keys.auth.trim()) {
      errors.push({ field: 'subscription.keys.auth', message: 'keys.auth must be a non-empty string' });
    }
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    await db.query(
      'UPDATE users SET push_subscription = $1 WHERE id = $2',
      [JSON.stringify(subscription), req.user.userId],
    );

    // Start Horizon stream for this user if not already running
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
      [req.user.userId],
    );
    if (walletResult.rows[0]) {
      ledgerListener.addPushTarget(req.user.userId, walletResult.rows[0].public_key);
    }

    res.json({ message: 'Push subscription saved' });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/notifications/subscribe
 * Removes the stored push subscription for the current user.
 */
async function unsubscribe(req, res, next) {
  try {
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
      [req.user.userId],
    );
    if (walletResult.rows[0]) {
      ledgerListener.removePushTarget(walletResult.rows[0].public_key);
    }

    await db.query(
      'UPDATE users SET push_subscription = NULL WHERE id = $1',
      [req.user.userId],
    );
    res.json({ message: 'Push subscription removed' });
  } catch (err) {
    next(err);
  }
}

/**
 * Send a Web Push notification to a specific user by their DB user id.
 * Called internally by the Horizon streaming worker.
 * Also persists to in-app notification inbox and broadcasts via Socket.IO.
 */
async function sendPushToUser(userId, payload) {
  const { rows } = await db.query(
    'SELECT id, push_subscription, push_subscription_active FROM users WHERE id = $1',
    [userId],
  );
  const row = rows[0];

  if (payload) {
    try {
      await persistAndBroadcast(userId, 'push', payload.title, payload.body, payload.data);
    } catch (err) {
      logger.warn('Failed to persist notification', { error: err.message, userId });
    }
  }

  if (!row?.push_subscription) return;

  // Subscription has been deactivated after repeated delivery failures —
  // don't waste a send attempt until the user re-subscribes.
  if (row.push_subscription_active === false) return;

  // Failures (including permanent 410/404) are tracked and, if needed,
  // deactivated inside webpush.sendNotification — nothing further to do here.
  await webpush.sendNotification(row.push_subscription, JSON.stringify(payload), row.id, db).catch(() => {});
}

/**
 * GET /api/notifications/subscription-health
 * Lets the frontend (PushNotificationPrompt.jsx) know whether the user's
 * push subscription has been deactivated after repeated delivery failures,
 * so it can re-prompt the user to re-subscribe.
 */
async function getSubscriptionHealth(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT push_subscription IS NOT NULL AS has_subscription,
              COALESCE(push_subscription_active, true) AS active,
              COALESCE(push_failure_count, 0) AS failure_count
         FROM users WHERE id = $1`,
      [req.user.userId],
    );
    const row = rows[0] || {};
    const hasSubscription = !!row.has_subscription;
    res.json({
      hasSubscription,
      active: hasSubscription ? !!row.active : false,
      failureCount: parseInt(row.failure_count, 10) || 0,
      needsResubscribe: hasSubscription && row.active === false,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/notifications/dead-letter
 * Admin-only: inspect undeliverable notifications.
 */
async function getDeadLetterNotifications(req, res, next) {
  try {
    const items = await webpush.getDeadLetter();
    res.json(items);
  } catch (err) {
    next(err);
  }
}

module.exports = { subscribe, unsubscribe, sendPushToUser, getDeadLetterNotifications, getSubscriptionHealth };
