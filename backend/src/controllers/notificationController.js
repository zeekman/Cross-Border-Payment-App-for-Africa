const db = require('../db');
const webpush = require('web-push');
const { startStreamForUser, stopStreamForUser } = require('../services/horizonWorker');

/**
 * POST /api/notifications/subscribe
 * Body: { subscription: PushSubscriptionJSON }
 */
async function subscribe(req, res, next) {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }

    await db.query(
      'UPDATE users SET push_subscription = $1 WHERE id = $2',
      [JSON.stringify(subscription), req.user.userId],
    );

    // Start Horizon stream for this user if not already running
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId],
    );
    if (walletResult.rows[0]) {
      startStreamForUser(req.user.userId, walletResult.rows[0].public_key);
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
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId],
    );
    if (walletResult.rows[0]) {
      stopStreamForUser(walletResult.rows[0].public_key);
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
 */
async function sendPushToUser(userId, payload) {
  const { rows } = await db.query(
    'SELECT push_subscription FROM users WHERE id = $1',
    [userId],
  );
  const sub = rows[0]?.push_subscription;
  if (!sub) return; // user hasn't subscribed

  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    // 410 Gone = subscription expired/revoked — clean it up
    if (err.statusCode === 410) {
      await db.query('UPDATE users SET push_subscription = NULL WHERE id = $1', [userId]);
    }
  }
}

module.exports = { subscribe, unsubscribe, sendPushToUser };
