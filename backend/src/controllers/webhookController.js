const crypto = require('crypto');
const db = require('../db');
const { validatePublicUrl } = require('../utils/ssrfValidator');
const { validateOutboundUrl } = require('../utils/ssrf');
const { encryptSecret, decryptSecret } = require('../utils/symmetricEncryption');
const { retryDelivery, attemptDelivery } = require('../services/webhook');

const { WEBHOOK_EVENTS: VALID_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS } = require('../services/webhookEvents');

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

// FE-203: summary of an endpoint's delivery health for the Webhooks page.
function buildHealth(wh, stats) {
  const total = Number(stats.total_24h) || 0;
  const delivered = Number(stats.delivered_24h) || 0;
  let status = 'healthy';
  if (wh.disabled_at || !wh.active) status = 'disabled';
  else if ((wh.consecutive_failures || 0) > 0) status = 'failing';
  return {
    status,
    success_rate_24h: total ? Math.round((delivered / total) * 1000) / 10 : null,
    deliveries_24h: total,
    last_success_at: stats.last_success_at || null,
    consecutive_failures: wh.consecutive_failures || 0,
    pending_deliveries: Number(stats.pending_count) || 0,
  };
}

async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT w.id, w.url, w.events, w.active, w.created_at, w.secret,
              w.consecutive_failures, w.disabled_at, w.disabled_reason,
              h.total_24h, h.delivered_24h, h.last_success_at, h.pending_count
       FROM webhooks w
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE wd.created_at > NOW() - INTERVAL '24 hours' AND wd.status IN ('delivered', 'failed'))::int AS total_24h,
                COUNT(*) FILTER (WHERE wd.created_at > NOW() - INTERVAL '24 hours' AND wd.status = 'delivered')::int AS delivered_24h,
                MAX(COALESCE(wd.completed_at, wd.created_at)) FILTER (WHERE wd.status = 'delivered') AS last_success_at,
                COUNT(*) FILTER (WHERE wd.status = 'pending')::int AS pending_count
         FROM webhook_deliveries wd WHERE wd.webhook_id = w.id
       ) h ON TRUE
       WHERE w.user_id = $1 ORDER BY w.created_at DESC`,
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
      const { secret: _omit, total_24h, delivered_24h, last_success_at, pending_count, ...rest } = wh;
      return {
        ...rest,
        secret_masked: secretMasked,
        health: buildHealth(rest, { total_24h, delivered_24h, last_success_at, pending_count }),
      };
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
    if (['delivered', 'failed', 'pending'].includes(req.query.status)) {
      params.push(req.query.status);
      query += ` AND wd.status = $${params.length}`;
    }
    if (req.query.event_type) {
      params.push(String(req.query.event_type));
      query += ` AND wd.event_type = $${params.length}`;
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit + 1, offset);
    query += ` ORDER BY wd.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await db.query(query, params);
    res.json({ deliveries: rows.slice(0, limit), has_more: rows.length > limit });
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
           active = COALESCE($3, active),
           -- Re-enabling an endpoint (BE-217) starts it with a clean slate, otherwise the
           -- next single failure would put it straight back over the auto-disable threshold.
           consecutive_failures = CASE WHEN $3::boolean IS TRUE THEN 0 ELSE consecutive_failures END,
           disabled_at = CASE WHEN $3::boolean IS TRUE THEN NULL ELSE disabled_at END,
           disabled_reason = CASE WHEN $3::boolean IS TRUE THEN NULL ELSE disabled_reason END
       WHERE id = $4 AND user_id = $5
       RETURNING id, url, events, active, created_at, consecutive_failures, disabled_at, disabled_reason`,
      [url || null, events || null, active !== undefined ? active : null, id, req.user.userId]
    );

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

function listEvents(req, res) {
  res.json({
    events: VALID_EVENTS.map((name) => ({ name, description: WEBHOOK_EVENT_DESCRIPTIONS[name] })),
  });
}

/**
 * POST /api/webhooks/:id/reenable (FE-203)
 * Sends a test delivery to an auto-disabled endpoint and only re-enables it
 * (with a clean failure streak) when that delivery succeeds.
 */
async function reenable(req, res, next) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM webhooks WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Webhook not found' });
    const payload = { event: 'webhook.test', data: { webhook_id: rows[0].id }, timestamp: new Date().toISOString() };
    try {
      await attemptDelivery(rows[0], payload, 1, 1);
    } catch (err) {
      return res.status(422).json({ error: `Test delivery failed: ${err.message}` });
    }
    const { rows: updated } = await db.query(
      `UPDATE webhooks SET active = TRUE, consecutive_failures = 0, disabled_at = NULL, disabled_reason = NULL
       WHERE id = $1 AND user_id = $2
       RETURNING id, url, events, active, created_at, consecutive_failures, disabled_at, disabled_reason`,
      [req.params.id, req.user.userId]
    );
    res.json(updated[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listEvents, create, update, list, listDeliveries, retry, rotateSecret, reenable };
