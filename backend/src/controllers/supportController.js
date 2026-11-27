const fs = require('fs');
const path = require('path');
const db = require('../db');
const audit = require('../services/audit');
const logger = require('../utils/logger');
const { persistAndBroadcast } = require('../services/notificationInbox');
const { enqueueEmail, escapeHtml } = require('../services/email');

const VALID_TYPES = ['wrong_address', 'wrong_amount', 'failed_deducted', 'other'];
const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
// Allowed admin status transitions. A closed ticket can only be reopened by an admin.
const ADMIN_TRANSITIONS = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['open', 'resolved', 'closed'],
  resolved: ['open', 'in_progress', 'closed'],
  closed: ['open'],
};
const USER_REOPEN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function cleanupFiles(files) {
  if (!files) return;
  for (const f of files) {
    try { fs.unlinkSync(f.path); } catch {}
  }
}

async function createTicket(req, res, next) {
  try {
    const { transaction_id, tx_hash, type, description } = req.body;

    if (!VALID_TYPES.includes(type)) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }

    let linkedTxId = null;
    if (transaction_id || tx_hash) {
      const txCheck = await db.query(
        `SELECT id FROM transactions
         WHERE ${transaction_id ? 'id = $1' : 'tx_hash = $1'} AND (
           sender_wallet = ANY(SELECT public_key FROM wallets WHERE user_id = $2)
           OR recipient_wallet = ANY(SELECT public_key FROM wallets WHERE user_id = $2)
         )
         LIMIT 1`,
        [transaction_id || tx_hash, req.user.userId]
      );
      if (!txCheck.rows[0]) {
        cleanupFiles(req.files);
        return res.status(404).json({ error: 'Transaction not found or does not belong to you' });
      }
      linkedTxId = txCheck.rows[0].id;
    }

    const result = await db.query(
      `INSERT INTO support_tickets (user_id, transaction_id, type, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.userId, linkedTxId, type, description]
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

// ---------------------------------------------------------------------------
// Ticket detail, messages and lifecycle (BE-205)
// ---------------------------------------------------------------------------

async function loadTicketDetail(ticketId) {
  const { rows } = await db.query('SELECT * FROM support_tickets WHERE id = $1', [ticketId]);
  if (!rows[0]) return null;
  const [attachments, messages] = await Promise.all([
    db.query(
      `SELECT id, filename, original_name, mime_type, size_bytes, uploaded_at
       FROM support_attachments WHERE ticket_id = $1 ORDER BY uploaded_at ASC`,
      [ticketId]
    ),
    db.query(
      `SELECT id, ticket_id, author_id, author_role, body, created_at
       FROM support_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [ticketId]
    ),
  ]);
  return { ...rows[0], attachments: attachments.rows, messages: messages.rows };
}

async function findOwnTicket(ticketId, userId) {
  const { rows } = await db.query(
    'SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2',
    [ticketId, userId]
  );
  return rows[0] || null;
}

async function notifyUser(ticket, title, body) {
  try {
    await persistAndBroadcast(ticket.user_id, 'support_ticket', title, body, { ticket_id: ticket.id });
    const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [ticket.user_id]);
    if (rows[0] && rows[0].email) {
      await enqueueEmail({
        to: rows[0].email,
        subject: `[Support #${ticket.id}] ${title}`,
        html: `<p>${escapeHtml(body)}</p><p>Ticket #${ticket.id}</p>`,
      });
    }
  } catch (err) {
    logger.warn('Failed to notify user about support ticket update', {
      error: err.message,
      ticketId: ticket.id,
    });
  }
}

async function addMessage(ticketId, authorId, authorRole, body) {
  const { rows } = await db.query(
    `INSERT INTO support_messages (ticket_id, author_id, author_role, body)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [ticketId, authorId, authorRole, body]
  );
  await db.query('UPDATE support_tickets SET updated_at = NOW() WHERE id = $1', [ticketId]);
  return rows[0];
}

/** GET /support/tickets/:id */
async function getTicket(req, res, next) {
  try {
    const own = await findOwnTicket(req.params.id, req.user.userId);
    if (!own) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ticket: await loadTicketDetail(own.id) });
  } catch (err) {
    next(err);
  }
}

/** POST /support/tickets/:id/messages — user reply; reopens a resolved ticket. */
async function addUserMessage(req, res, next) {
  try {
    const ticket = await findOwnTicket(req.params.id, req.user.userId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.status === 'closed') {
      const closedAt = ticket.closed_at ? new Date(ticket.closed_at).getTime() : 0;
      if (Date.now() - closedAt > USER_REOPEN_WINDOW_MS) {
        return res.status(409).json({ error: 'Ticket was closed more than 30 days ago; please open a new ticket' });
      }
    }
    const message = await addMessage(ticket.id, req.user.userId, 'user', req.body.body);
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      await db.query(
        `UPDATE support_tickets SET status = 'open', resolved_at = NULL, closed_at = NULL, updated_at = NOW()
         WHERE id = $1`,
        [ticket.id]
      );
    }
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
}

/** POST /support/tickets/:id/close */
async function closeTicket(req, res, next) {
  try {
    const ticket = await findOwnTicket(req.params.id, req.user.userId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.status === 'closed') return res.status(409).json({ error: 'Ticket is already closed' });
    const { rows } = await db.query(
      `UPDATE support_tickets SET status = 'closed', closed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [ticket.id]
    );
    res.json({ ticket: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

/** GET /admin/support/tickets?status=&type=&q=&assigned_to=&limit=&offset= */
async function adminListTickets(req, res, next) {
  try {
    const { status, type, q, assigned_to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`t.status = $${params.length}`); }
    if (type) { params.push(type); where.push(`t.type = $${params.length}`); }
    if (assigned_to) { params.push(assigned_to); where.push(`t.assigned_to = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(t.description ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT t.*, u.email AS user_email
       FROM support_tickets t JOIN users u ON u.id = t.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ tickets: rows, limit, offset });
  } catch (err) {
    next(err);
  }
}

/** GET /admin/support/tickets/:id */
async function adminGetTicket(req, res, next) {
  try {
    const ticket = await loadTicketDetail(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
}

/** PATCH /admin/support/tickets/:id  { status?, assigned_to? } */
async function adminUpdateTicket(req, res, next) {
  try {
    const { rows: existing } = await db.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
    const ticket = existing[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { status, assigned_to } = req.body;
    const sets = [];
    const params = [];
    if (status !== undefined && status !== ticket.status) {
      if (!(ADMIN_TRANSITIONS[ticket.status] || []).includes(status)) {
        return res.status(409).json({ error: `Cannot move ticket from ${ticket.status} to ${status}` });
      }
      params.push(status);
      sets.push(`status = $${params.length}`);
      sets.push(status === 'resolved' ? 'resolved_at = NOW()' : status === 'open' || status === 'in_progress' ? 'resolved_at = NULL' : 'resolved_at = resolved_at');
      sets.push(status === 'closed' ? 'closed_at = NOW()' : 'closed_at = NULL');
    }
    if (assigned_to !== undefined) {
      params.push(assigned_to || null);
      sets.push(`assigned_to = $${params.length}`);
    }
    if (!sets.length) return res.json({ ticket });

    params.push(ticket.id);
    const { rows } = await db.query(
      `UPDATE support_tickets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );
    const updated = rows[0];

    await audit.auditLog(req, 'support_ticket_updated', {
      type: 'support_ticket',
      id: String(ticket.id),
      oldValue: { status: ticket.status, assigned_to: ticket.assigned_to },
      newValue: { status: updated.status, assigned_to: updated.assigned_to },
    });
    if (updated.status !== ticket.status) {
      await notifyUser(updated, 'Ticket status updated', `Your support ticket is now ${updated.status.replace('_', ' ')}.`);
    }
    res.json({ ticket: updated });
  } catch (err) {
    next(err);
  }
}

/** POST /admin/support/tickets/:id/messages */
async function adminAddMessage(req, res, next) {
  try {
    const { rows } = await db.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const message = await addMessage(ticket.id, req.user.userId, 'admin', req.body.body);
    if (ticket.status === 'open') {
      await db.query(`UPDATE support_tickets SET status = 'in_progress' WHERE id = $1`, [ticket.id]);
    }
    await audit.auditLog(req, 'support_ticket_reply', {
      type: 'support_ticket',
      id: String(ticket.id),
      newValue: { message_id: message.id },
    });
    await notifyUser(ticket, 'New reply from support', req.body.body.slice(0, 200));
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  VALID_STATUSES,
  createTicket,
  listTickets,
  getAttachment,
  getTicket,
  addUserMessage,
  closeTicket,
  adminListTickets,
  adminGetTicket,
  adminUpdateTicket,
  adminAddMessage,
};
