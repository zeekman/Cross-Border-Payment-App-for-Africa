const crypto = require('crypto');
const db = require('../db');
const { validatePublicUrl } = require('../utils/ssrfValidator');
const { validateOutboundUrl } = require('../utils/ssrf');
const { encryptSecret, decryptSecret } = require('../utils/symmetricEncryption');
const { retryDelivery } = require('../services/webhook');

const { WEBHOOK_EVENTS: VALID_EVENTS } = require('../services/webhookEvents');

// Shared URL validation for create/update: HTTPS-only + SSRF check.
async function validateWebhookUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { status: 400, body: { error: 'Invalid URL format' } };
  }
  if (parsedUrl.protocol !== 'https:') {
    return { status: 400, body: { error: 'Webhook URL must use HTTPS' } };
  }
  const ssrfCheck = await validateOutboundUrl(url);
  if (!ssrfCheck.valid) {
    return {
      status: 400,
      body: {
        error: 'SSRF_BLOCKED',
        message: 'The provided URL resolves to a restricted network range.',
      },
    };
  }
  return null;
}

async function create(req, res, next) {
  try {
    const { url, events } = req.body;

    // Webhook endpoints must be HTTPS to protect the HMAC secret in transit
    const urlError = await validateWebhookUrl(url);
    if (urlError) return res.status(urlError.status).json(urlError.body);

    const invalidEvents = (events || []).filter((e) => !VALID_EVENTS.includes(e));
    if (invalidEvents.length) {
      return res.status(400).json({ error: `Invalid events: ${invalidEvents.join(', ')}` });
    }

    const plainSecret = crypto.randomBytes(32).toString('hex');
    const encryptedSecret = encryptSecret(plainSecret);

    const { rows } = await db.query(
      `INSERT INTO webhooks (user_id, url, secret, events)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, events, active, created_at`,
      [req.user.userId, url, encryptedSecret, events || []]
    );

    // Return the plain secret once — it will not be shown again
    res.status(201).json({ ...rows[0], secret: plainSecret });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, url, events, active, created_at, secret FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );

    const webhooks = rows.map((wh) => {
      let secretMasked = null;
      if (wh.secret) {
        try {
          const plain = decryptSecret(wh.secret);
          secretMasked = plain.slice(0, 4) + '****';
        } catch {
          secretMasked = '****';
        }
      }
      const { secret: _omit, ...rest } = wh;
      return { ...rest, secret_masked: secretMasked };
    });

    res.json({ webhooks });
  } catch (err) {
    next(err);
  }
}

async function listDeliveries(req, res, next) {
  try {
    const { webhook_id } = req.query;
    let query = `
      SELECT wd.id, wd.webhook_id, wd.event_type, wd.target_url, wd.status_code,
             wd.response_time_ms, wd.status, wd.attempt, wd.max_attempts, wd.error_message,
             wd.created_at, wd.completed_at
      FROM webhook_deliveries wd
      JOIN webhooks w ON w.id = wd.webhook_id
      WHERE w.user_id = $1
    `;
    const params = [req.user.userId];
    if (webhook_id) {
      params.push(webhook_id);
      query += ` AND wd.webhook_id = $${params.length}`;
    }
    query += ` ORDER BY wd.created_at DESC LIMIT 100`;
    const { rows } = await db.query(query, params);
    res.json({ deliveries: rows });
  } catch (err) {
    next(err);
  }
}

const ROTATION_OVERLAP_HOURS = parseInt(process.env.WEBHOOK_SECRET_ROTATION_OVERLAP_HOURS || '24', 10);

/**
 * POST /api/webhooks/:id/rotate-secret
 * Issues a new signing secret while keeping the old one valid for a grace
 * window, so in-flight deliveries and not-yet-updated verifiers don't break.
 */
async function rotateSecret(req, res, next) {
  try {
    const { id } = req.params;

    const { rows } = await db.query(
      `SELECT id, secret FROM webhooks WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const newPlainSecret = crypto.randomBytes(32).toString('hex');
    const newEncryptedSecret = encryptSecret(newPlainSecret);

    const { rows: updated } = await db.query(
      `UPDATE webhooks
          SET secret = $1,
              previous_secret = $2,
              previous_secret_expires_at = NOW() + ($3 || ' hours')::interval
        WHERE id = $4
        RETURNING id, url, events, active, created_at, previous_secret_expires_at`,
      [newEncryptedSecret, rows[0].secret, ROTATION_OVERLAP_HOURS, id]
    );

    // Return the plain secret once — it will not be shown again
    res.json({ ...updated[0], secret: newPlainSecret, rotation_overlap_hours: ROTATION_OVERLAP_HOURS });
  } catch (err) {
    next(err);
  }
}

async function retry(req, res, next) {
  try {
    const { id } = req.params;
    // Verify ownership
    const { rows } = await db.query(
      `SELECT wd.id FROM webhook_deliveries wd
       JOIN webhooks w ON w.id = wd.webhook_id
       WHERE wd.id = $1 AND w.user_id = $2`,
      [id, req.user.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Delivery not found or not owned by user' });
    }
    await retryDelivery(id);
    res.json({ message: 'Retry initiated' });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const { url, events, active } = req.body;

    // Verify ownership
    const { rows: owned } = await db.query(
      `SELECT id FROM webhooks WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    if (!owned.length) return res.status(404).json({ error: 'Webhook not found' });

    if (url !== undefined) {
      const urlError = await validateWebhookUrl(url);
      if (urlError) return res.status(urlError.status).json(urlError.body);
    }

    const invalidEvents = (events || []).filter((e) => !VALID_EVENTS.includes(e));
    if (invalidEvents.length) {
      return res.status(400).json({ error: `Invalid events: ${invalidEvents.join(', ')}` });
    }

    const { rows } = await db.query(
      `UPDATE webhooks
       SET url = COALESCE($1, url),
           events = COALESCE($2, events),
           active = COALESCE($3, active)
       WHERE id = $4 AND user_id = $5
       RETURNING id, url, events, active, created_at`,
      [url || null, events || null, active !== undefined ? active : null, id, req.user.userId]
    );

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { create, update, list, listDeliveries, retry, rotateSecret };
