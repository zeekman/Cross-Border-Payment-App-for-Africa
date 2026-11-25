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

    // BE-177: one row per device, upserted by endpoint.
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent, active = true, failure_count = 0`,
      [req.user.userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
        req.get('user-agent') || null],
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
 * Body: { endpoint } (or { subscription: { endpoint } })
 * Removes this device's push subscription; other devices stay subscribed.
 */
async function unsubscribe(req, res, next) {
  try {
    const endpoint = req.body?.endpoint || req.body?.subscription?.endpoint;
    if (!endpoint) {
      return res.status(400).json({ errors: [{ field: 'endpoint', message: 'endpoint is required' }] });
    }

    await db.query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [req.user.userId, endpoint],
    );

    const { rows } = await db.query(
      'SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1',
      [req.user.userId],
    );
    if (!rows[0]) {
      const walletResult = await db.query(
        'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
        [req.user.userId],
      );
      if (walletResult.rows[0]) {
        ledgerListener.removePushTarget(walletResult.rows[0].public_key);
      }
    }

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
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1 AND active = true',
    [userId],
  );

  if (payload) {
    try {
      await persistAndBroadcast(userId, 'push', payload.title, payload.body, payload.data);
    } catch (err) {
      logger.warn('Failed to persist notification', { error: err.message, userId });
    }
  }

  // Fan out to every active device. Failures (including permanent 410/404)
  // are tracked per subscription inside webpush.sendNotification.
  const body = JSON.stringify(payload);
  await Promise.all(rows.map((sub) => webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, sub.id, db,
  ).catch(() => {})));
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
      `SELECT COUNT(*) > 0 AS has_subscription,
              COALESCE(BOOL_OR(active), true) AS active,
              COALESCE(MIN(failure_count), 0) AS failure_count
         FROM push_subscriptions WHERE user_id = $1`,
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
