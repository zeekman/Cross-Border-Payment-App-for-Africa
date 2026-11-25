const fs = require('fs');
const path = require('path');
const db = require('../db');

const VALID_TYPES = ['wrong_address', 'wrong_amount', 'failed_deducted', 'other'];

function cleanupFiles(files) {
  if (!files) return;
  for (const f of files) {
    try { fs.unlinkSync(f.path); } catch {}
  }
}

async function createTicket(req, res, next) {
  try {
    const { transaction_id, type, description } = req.body;

    if (!VALID_TYPES.includes(type)) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }

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
        cleanupFiles(req.files);
        return res.status(404).json({ error: 'Transaction not found or does not belong to you' });
      }
    }

    const result = await db.query(
      `INSERT INTO support_tickets (user_id, transaction_id, type, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.userId, transaction_id || null, type, description]
    );

    const ticket = result.rows[0];

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        await db.query(
          `INSERT INTO support_attachments (ticket_id, filename, original_name, mime_type, size_bytes, storage_path)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [ticket.id, file.filename, file.originalname, file.mimetype, file.size, file.path]
        );
      }
    }

    const attachmentsResult = await db.query(
      `SELECT id, filename, original_name, mime_type, size_bytes, uploaded_at
       FROM support_attachments WHERE ticket_id = $1 ORDER BY uploaded_at ASC`,
      [ticket.id]
    );

    res.status(201).json({ ticket: { ...ticket, attachments: attachmentsResult.rows } });
  } catch (err) {
    cleanupFiles(req.files);
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

async function getAttachment(req, res, next) {
  try {
    const { id, filename } = req.params;
    const safeFilename = path.basename(filename);
    const isAdmin = req.user.role === 'admin';

    const { rows } = isAdmin
      ? await db.query(
          `SELECT a.* FROM support_attachments a
           WHERE a.ticket_id = $1 AND a.filename = $2`,
          [id, safeFilename]
        )
      : await db.query(
          `SELECT a.* FROM support_attachments a
           JOIN support_tickets t ON t.id = a.ticket_id
           WHERE a.ticket_id = $1 AND a.filename = $2 AND t.user_id = $3`,
          [id, safeFilename, req.user.userId]
        );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const attachment = rows[0];

    if (!fs.existsSync(attachment.storage_path)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${attachment.original_name.replace(/"/g, '\\"')}"`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', attachment.size_bytes);

    fs.createReadStream(attachment.storage_path).pipe(res);
  } catch (err) {
    next(err);
  }
}

module.exports = { createTicket, listTickets, getAttachment };
