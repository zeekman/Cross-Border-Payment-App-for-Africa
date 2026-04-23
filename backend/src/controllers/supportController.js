const db = require('../db');

const VALID_TYPES = ['wrong_address', 'wrong_amount', 'failed_deducted', 'other'];

async function createTicket(req, res, next) {
  try {
    const { transaction_id, type, description } = req.body;

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }

    // If a transaction_id is provided, verify it belongs to this user
    if (transaction_id) {
      const txCheck = await db.query(
        `SELECT id FROM transactions
         WHERE id = $1 AND (
           sender_wallet = (SELECT public_key FROM wallets WHERE user_id = $2)
           OR recipient_wallet = (SELECT public_key FROM wallets WHERE user_id = $2)
         )`,
        [transaction_id, req.user.userId]
      );
      if (!txCheck.rows[0]) {
        return res.status(404).json({ error: 'Transaction not found or does not belong to you' });
      }
    }

    const result = await db.query(
      `INSERT INTO support_tickets (user_id, transaction_id, type, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.userId, transaction_id || null, type, description]
    );

    res.status(201).json({ ticket: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

async function listTickets(req, res, next) {
  try {
    const result = await db.query(
      `SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json({ tickets: result.rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { createTicket, listTickets };
