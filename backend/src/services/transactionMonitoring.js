'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const DEFAULT_SLA_HOURS = 24;

async function openCase({
  userId,
  senderWallet,
  recipientWallet,
  amount,
  asset,
  source,
  ruleName = null,
  reason,
  paymentId = null,
  metadata = {},
  slaHours = DEFAULT_SLA_HOURS,
}) {
  if (!userId || !senderWallet || !recipientWallet || !amount || !asset || !source || !reason) {
    throw new Error('Transaction-monitoring case is missing required payment or alert details');
  }
  const hours = Number(slaHours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
    throw new Error('Transaction-monitoring SLA must be between 0 and 720 hours');
  }

  const id = uuidv4();
  const { rows } = await db.query(
    `INSERT INTO tm_cases
       (id, user_id, payment_id, sender_wallet, recipient_wallet, amount, asset,
        source, rule_name, reason, metadata, sla_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
             NOW() + ($12 * INTERVAL '1 hour'))
     RETURNING id, status, sla_due_at, created_at`,
    [
      id, userId, paymentId, senderWallet, recipientWallet, amount, asset,
      source, ruleName, reason, JSON.stringify(metadata), hours,
    ]
  );
  return rows[0];
}

async function listCases({ status = null, overdueOnly = false, limit = 100, offset = 0 } = {}) {
  const params = [];
  const filters = [];
  if (status) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  if (overdueOnly) filters.push(`status != 'closed' AND sla_due_at < NOW()`);
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const limitParam = `$${params.length}`;
  params.push(Math.max(Number(offset) || 0, 0));
  const offsetParam = `$${params.length}`;

  const { rows } = await db.query(
    `SELECT id, user_id, payment_id, sender_wallet, recipient_wallet, amount, asset,
            source, rule_name, reason, metadata, status, disposition,
            disposition_reason, assigned_to, sla_due_at, str_reference,
            str_filed_at, created_at, updated_at
     FROM tm_cases
     ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
     ORDER BY CASE WHEN status = 'closed' THEN 1 ELSE 0 END, sla_due_at ASC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );
  return rows;
}

async function getCase(id) {
  const { rows } = await db.query('SELECT * FROM tm_cases WHERE id = $1', [id]);
  return rows[0] || null;
}

async function updateCase(id, { status, disposition, reason, assignedTo, strReference }) {
  if (status && !['open', 'under_review', 'closed'].includes(status)) {
    throw Object.assign(new Error('status must be open, under_review, or closed'), { status: 400 });
  }
  if (disposition && !['released', 'rejected', 'confirmed', 'false_positive'].includes(disposition)) {
    throw Object.assign(new Error('Invalid case disposition'), { status: 400 });
  }
  if (disposition && (!reason || !reason.trim())) {
    throw Object.assign(new Error('A disposition reason is required'), { status: 400 });
  }
  if (strReference !== undefined && (typeof strReference !== 'string' || strReference.trim().length === 0)) {
    throw Object.assign(new Error('str_reference must be a non-empty string'), { status: 400 });
  }
  if (status === 'closed' && !disposition) {
    throw Object.assign(new Error('A disposition is required to close a case'), { status: 400 });
  }

  const { rows } = await db.query(
    `UPDATE tm_cases
     SET status = COALESCE($2, CASE WHEN $3 IS NOT NULL THEN 'closed' ELSE status END),
         disposition = COALESCE($3, disposition),
         disposition_reason = COALESCE($4, disposition_reason),
         assigned_to = COALESCE($5, assigned_to),
         str_reference = COALESCE($6, str_reference),
         str_filed_at = CASE WHEN $6::text IS NOT NULL AND str_filed_at IS NULL THEN NOW() ELSE str_filed_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, status || null, disposition || null, reason ? reason.trim() : null, assignedTo || null, strReference || null]
  );
  return rows[0] || null;
}

module.exports = { openCase, listCases, getCase, updateCase };
