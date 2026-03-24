const crypto = require('crypto');
const db = require('../db');

const VALID_EVENTS = ['payment.sent', 'payment.received', 'payment.failed'];

async function create(req, res, next) {
  try {
    const { url, events } = req.body;

    if (!url || !url.startsWith('https://')) {
      return res.status(400).json({ error: 'Webhook URL must use HTTPS' });
    }

    const invalidEvents = (events || []).filter((e) => !VALID_EVENTS.includes(e));
    if (invalidEvents.length) {
      return res.status(400).json({ error: `Invalid events: ${invalidEvents.join(', ')}` });
    }

    const secret = crypto.randomBytes(32).toString('hex');
    const { rows } = await db.query(
      `INSERT INTO webhooks (user_id, url, secret, events)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, events, active, created_at`,
      [req.user.userId, url, secret, events || []]
    );

    res.status(201).json({ ...rows[0], secret });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, url, events, active, created_at FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json({ webhooks: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list };
