const { v4: uuidv4 } = require('uuid');
const db = require('../db');

async function getContacts(req, res, next) {
  try {
    const { tag } = req.query;
    let query = 'SELECT id, name, wallet_address, notes, memo_required, default_memo, tags, created_at FROM contacts WHERE user_id = $1';
    const params = [req.user.userId];
    if (tag) {
      query += ' AND $2 = ANY(tags)';
      params.push(tag);
    }
    query += ' ORDER BY name';
    const result = await db.query(query, params);
    res.json({ contacts: result.rows });
  } catch (err) { next(err); }
}

async function addContact(req, res, next) {
  try {
    const { name, wallet_address, notes, memo_required, default_memo, tags } = req.body;
    const id = uuidv4();
    const result = await db.query(
      `INSERT INTO contacts (id, user_id, name, wallet_address, notes, memo_required, default_memo, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, wallet_address) DO UPDATE
         SET name = $3, notes = $5, memo_required = $6, default_memo = $7, tags = $8
       RETURNING id, name, wallet_address, notes, memo_required, default_memo, tags`,
      [id, req.user.userId, name, wallet_address,
       notes || null, memo_required || false, default_memo || null, tags || []]
    );
    res.status(201).json({ message: 'Contact saved', contact: result.rows[0] });
  } catch (err) { next(err); }
}

async function deleteContact(req, res, next) {
  try {
    const result = await db.query(
      'DELETE FROM contacts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json({ message: 'Contact deleted' });
  } catch (err) { next(err); }
}

module.exports = { getContacts, addContact, deleteContact };
