const { v4: uuidv4 } = require('uuid');
const db = require('../db');

async function create(req, res, next) {
  try {
    const { recipient_wallet, amount, asset = 'XLM', frequency, memo, execute_at } = req.body;
    const userId = req.user.userId;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }
    if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
      return res.status(400).json({ error: 'Invalid frequency' });
    }

    const id = uuidv4();
    const nextRunAt = new Date(execute_at);

    await db.query(
      `INSERT INTO scheduled_payments (id, user_id, recipient_wallet, amount, asset, frequency, next_run_at, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, userId, recipient_wallet, amount, asset, frequency, nextRunAt, memo || null]
    );

    res.json({ id, message: 'Scheduled payment created' });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const userId = req.user.userId;

    const result = await db.query(
      `SELECT id, recipient_wallet, amount, asset, frequency, next_run_at, active, last_run_at, failed_attempts
       FROM scheduled_payments
       WHERE user_id = $1
       ORDER BY next_run_at ASC`,
      [userId]
    );

    res.json({ payments: result.rows });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { amount, frequency, active, recipient_wallet } = req.body;
    const userId = req.user.userId;

    await db.query(
      `UPDATE scheduled_payments
       SET amount = COALESCE($1, amount),
           frequency = COALESCE($2, frequency),
           active = COALESCE($3, active),
           recipient_wallet = COALESCE($4, recipient_wallet)
       WHERE id = $5 AND user_id = $6`,
      [amount, frequency, active, recipient_wallet, id, userId]
    );

    res.json({ message: 'Scheduled payment updated' });
  } catch (err) {
    next(err);
  }
}

async function delete_(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    await db.query(
      `DELETE FROM scheduled_payments WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    res.json({ message: 'Scheduled payment deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list, update, delete: delete_ };
