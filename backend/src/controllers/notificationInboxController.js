const db = require('../db');

async function listNotifications(req, res, next) {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;

    const conditions = ['user_id = $1'];
    const params = [req.user.userId];

    if (cursor) {
      params.push(cursor);
      conditions.push(`id < $${params.length}`);
    }

    const where = conditions.join(' AND ');
    params.push(limit + 1);

    const { rows } = await db.query(
      `SELECT * FROM notifications
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    res.json({ data, next_cursor: nextCursor, has_more: hasMore });
  } catch (err) {
    next(err);
  }
}

async function markAsRead(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `UPDATE notifications SET read_at = NOW()
       WHERE id = $1 AND user_id = $2 AND read_at IS NULL
       RETURNING *`,
      [id, req.user.userId]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Notification not found or already read' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function markAllAsRead(req, res, next) {
  try {
    const { rows } = await db.query(
      `UPDATE notifications SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL
       RETURNING id`,
      [req.user.userId]
    );
    res.json({ updated: rows.length });
  } catch (err) {
    next(err);
  }
}

async function getUnreadCount(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.userId]
    );
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
};