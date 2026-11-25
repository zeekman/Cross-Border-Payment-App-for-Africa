'use strict';

const https = require('https');
const { isValidEvent } = require('./webhookEvents');
const db = require('../db');
const { sign, buildSignatureHeader } = require('../utils/webhookSignature');
const { validateOutboundUrl } = require('../utils/ssrf');
const { decryptSecret } = require('../utils/symmetricEncryption');
const logger = require('../utils/logger');

const webhookSignature = require('../utils/webhookSignature');

const MAX_ATTEMPTS = 3;
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10);

/**
 * Perform a single HTTPS POST with the AfriPay webhook signature header.
 *
 * @param {string} url       - Fully-qualified HTTPS URL
 * @param {string} body      - JSON-serialised payload string
 * @param {string} signature - X-AfriPay-Signature-256 header value (see buildSignatureHeader)
 * @param {import('https').Agent|undefined} agent - DNS-pinned agent (SSRF protection)
 * @returns {Promise<number>} Resolves with the HTTP status code on 2xx
 */
async function isPublicHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname;

  // Reject bare private IPs
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && isPrivateIp(hostname)) {
    return false;
  }

  // Resolve and check returned IP
  try {
    const { address } = await require('dns').promises.lookup(hostname);
    if (isPrivateIp(address)) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function httpsPost(url, body, signature, meta = {}) {
function httpsPost(url, body, signature, agent) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const extraHeaders = {};
    if (meta.eventId) extraHeaders['X-AfriPay-Event-Id'] = meta.eventId;
    if (meta.deliveryId) extraHeaders['X-AfriPay-Delivery-Id'] = String(meta.deliveryId);
    if (meta.timestamp) {
      extraHeaders['X-AfriPay-Timestamp'] = String(meta.timestamp);
      extraHeaders['X-AfriPay-Signature-v2'] = webhookSignature.buildHeader(meta.secret, meta.timestamp, body);
    }
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        // Deprecated: body-only signature, kept for one deprecation cycle
        'X-AfriPay-Signature-256': `sha256=${signature}`,
        ...extraHeaders,
      },
      timeout: WEBHOOK_TIMEOUT_MS,
        'X-AfriPay-Signature-256': signature,
      },
      // Use the DNS-pinned agent from SSRF validation to prevent DNS rebinding
      ...(agent && { agent }),
    };
    const req = https.request(options, (res) => {
      res.resume();
      // Block redirects to prevent DNS rebinding via 3xx responses
      if (res.statusCode >= 300 && res.statusCode < 400) {
        return reject(
          new Error(`Redirect blocked (HTTP ${res.statusCode}) — follow redirects is disabled for security`)
        );
      }
      res.statusCode >= 200 && res.statusCode < 300
        ? resolve(res.statusCode)
        : reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function createDeliveryLog(webhookId, eventType, targetUrl, attempt, maxAttempts, payload) {
  const { rows } = await db.query(
    `INSERT INTO webhook_deliveries (webhook_id, event_type, target_url, status, attempt, max_attempts, payload)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6)
     RETURNING id`,
    [webhookId, eventType, targetUrl, attempt, maxAttempts, JSON.stringify(payload)]
  );
  return rows[0].id;
}

async function updateDeliveryLog(deliveryId, status, statusCode, responseTimeMs, errorMessage) {
  await db.query(
    `UPDATE webhook_deliveries
     SET status = $1, status_code = $2, response_time_ms = $3, error_message = $4, completed_at = NOW()
     WHERE id = $5`,
    [status, statusCode || null, responseTimeMs || null, errorMessage || null, deliveryId]
  );
}

// Delivery logging is best-effort: a failure to write the log must never
// block or fail the delivery itself.
async function safeCreateDeliveryLog(...args) {
  try {
    return await createDeliveryLog(...args);
  } catch (err) {
    logger.warn('Failed to create webhook delivery log', { error: err.message });
    return null;
  }
}

async function safeUpdateDeliveryLog(deliveryId, ...args) {
  if (!deliveryId) return;
  await updateDeliveryLog(deliveryId, ...args).catch((err) =>
    logger.warn('Failed to update webhook delivery log', { deliveryId, error: err.message })
  );
}

// Build the list of plaintext secrets a delivery should be signed with: the
// current secret, plus the previous one if it's still inside its rotation
// overlap window — lets a merchant who hasn't rolled their verification key
// yet keep validating deliveries sent right after a rotation.
function activeSecrets(row) {
  const secrets = [decryptSecret(row.secret)];
  if (row.previous_secret && row.previous_secret_expires_at && new Date(row.previous_secret_expires_at) > new Date()) {
    secrets.push(decryptSecret(row.previous_secret));
  }
  return secrets;
}

/**
 * A failed delivery attempt. `retryable: false` marks a failure retrying cannot
 * fix (the URL failed SSRF validation), so the queue stops retrying immediately.
 */
class DeliveryError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.retryable = retryable;
  }
}

/**
 * Make exactly one delivery attempt for a queued job (BE-217): validate the URL,
 * sign with the webhook's current secrets, POST, and write the delivery log row.
 * Throws a DeliveryError on any failure; retrying and backoff belong to the queue.
 *
 * `row` is the webhooks row loaded at send time. The decrypted secret is read here
 * and never stored in the job payload or kept in a scheduled closure.
 */
async function attemptDelivery(row, payload, attempt, maxAttempts) {
  const url = row.url;
  const ssrfCheck = await validateOutboundUrl(url);
  if (!ssrfCheck.valid) {
    logger.error('Webhook delivery blocked: URL failed SSRF validation', { url, reason: ssrfCheck.error });
    const blockedId = await safeCreateDeliveryLog(row.id, payload.event, url, attempt, maxAttempts, payload);
    await safeUpdateDeliveryLog(blockedId, 'failed', null, null, 'SSRF validation failed');
    throw new DeliveryError('SSRF validation failed', { retryable: false });
  }

  const body = JSON.stringify(payload);
  const signature = buildSignatureHeader(activeSecrets(row), body);
  const deliveryId = await safeCreateDeliveryLog(row.id, payload.event, url, attempt, maxAttempts, payload);
  const start = Date.now();

  try {
    const statusCode = await httpsPost(url, body, signature, ssrfCheck.agent);
    await safeUpdateDeliveryLog(deliveryId, 'delivered', statusCode, Date.now() - start, null);
    return { statusCode };
  } catch (err) {
    const errMessage = err.message.includes('Error:') ? err.message.replace(/^Error:\s*/, '') : err.message;
    await safeUpdateDeliveryLog(deliveryId, 'failed', null, Date.now() - start, errMessage);
    throw new DeliveryError(errMessage);
  }
}

/**
 * Deliver a webhook payload to a single subscriber URL with exponential-backoff retry.
 *
 * In-process fallback used only when the durable queue is unavailable (no REDIS_URL, or
 * Redis down at enqueue time). Retries here are timers: they are lost on restart and
 * cover about 3 seconds. The queue path (services/webhookQueue.js) is the durable one.
 *
 * On each failed attempt before the last one, logs a warning with metadata so
 * operators can track transient delivery failures.  After exhausting all attempts,
 * logs a single error.
 *
 * @param {string|null} webhookId - Subscriber row ID (for logging; may be null)
 * @param {string}      url       - Target HTTPS endpoint
 * @param {string|string[]} secrets - Plain-text HMAC secret(s) (already decrypted by caller);
 *                                   pass activeSecrets(row) to include a rotating previous secret
 * @param {object}      payload   - Object with at minimum { event: string }
 * @param {number}      [attempt=0] - Zero-based attempt counter (used internally for retries)
 */
async function deliverWithRetry(webhookId, url, secrets, payload, attempt = 0) {
  const ssrfCheck = await validateOutboundUrl(url);
  if (!ssrfCheck.valid) {
    logger.error('Webhook delivery blocked: URL failed SSRF validation', {
      url,
      reason: ssrfCheck.error,
    });
    const blockedId = await safeCreateDeliveryLog(webhookId, payload.event, url, attempt + 1, MAX_ATTEMPTS, payload);
    await safeUpdateDeliveryLog(blockedId, 'failed', null, null, 'SSRF validation failed');
    return;
  }
  if (!payload.id) payload = { ...payload, id: crypto.randomUUID() };

  const body = JSON.stringify(payload);
  const signature = buildSignatureHeader(Array.isArray(secrets) ? secrets : [secrets], body);
  const deliveryId = await safeCreateDeliveryLog(webhookId, payload.event, url, attempt + 1, MAX_ATTEMPTS, payload);
  const start = Date.now();

  try {
    const statusCode = await httpsPost(url, body, signature, {
      eventId: payload.id,
      deliveryId: deliveryId || crypto.randomUUID(),
      timestamp: Math.floor(Date.now() / 1000),
      secret,
    });
    const responseTime = Date.now() - start;
    await updateDeliveryLog(deliveryId, 'delivered', statusCode, responseTime, null);
    const statusCode = await httpsPost(url, body, signature, ssrfCheck.agent);
    await safeUpdateDeliveryLog(deliveryId, 'delivered', statusCode, Date.now() - start, null);
  } catch (err) {
    const errMessage = err.message.includes('Error:')
      ? err.message.replace(/^Error:\s*/, '')
      : err.message;
    await safeUpdateDeliveryLog(deliveryId, 'failed', null, Date.now() - start, errMessage);

    if (attempt < MAX_ATTEMPTS - 1) {
      await updateDeliveryLog(deliveryId, 'failed', statusCode, responseTime, err.message);
      const delay = Math.pow(2, attempt) * 1000;
      // Transient failure — log a warning and schedule a retry
      logger.warn('Webhook delivery failed, retrying', {
        url,
        attempt: attempt + 1,
        maxAttempts: MAX_ATTEMPTS,
        error: errMessage,
      });
      const delay = Math.pow(2, attempt) * 1000;
      setTimeout(() => deliverWithRetry(webhookId, url, secrets, payload, attempt + 1), delay);
    } else {
      // Final attempt failed — log an error and give up
      logger.error('Webhook delivery permanently failed', {
        url,
        event: payload.event,
        attempts: MAX_ATTEMPTS,
        error: errMessage,
      });
    }
  }
}

/**
 * Re-send a previously failed delivery (POST /api/webhooks/deliveries/:id/retry).
 * Signs with the webhook's current secret set, including a rotating previous secret.
 */
async function retryDelivery(deliveryId) {
  const { rows } = await db.query(
    `SELECT wd.webhook_id, wd.target_url, wd.payload, wd.event_type,
            w.user_id, w.active, w.url, w.secret, w.previous_secret, w.previous_secret_expires_at
     FROM webhook_deliveries wd
     JOIN webhooks w ON w.id = wd.webhook_id
     WHERE wd.id = $1 AND wd.status = 'failed'`,
    [deliveryId]
  );
  if (!rows.length) throw new Error('Delivery not found or not failed');
  const row = rows[0];
  const parsedPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const payload = { ...parsedPayload, event: row.event_type };

  const queue = getDeliveryQueue();
  if (queue) {
    // A disabled endpoint's jobs are skipped by the worker, so say so instead of
    // reporting a retry that will never be sent.
    if (row.active === false) throw new Error('Webhook endpoint is disabled. Re-enable it before retrying.');
    await queue.enqueueDelivery({ webhookId: row.webhook_id, userId: row.user_id, payload });
    return;
  }
  await deliverWithRetry(row.webhook_id, row.url, activeSecrets(row), payload);
}

/** The durable queue module when it is running, else null (legacy in-process delivery). */
function getDeliveryQueue() {
  const queue = require('./webhookQueue');
  return queue.isQueueEnabled() ? queue : null;
}

/**
 * Fan-out a webhook event to every active subscriber registered for that event.
 *
 * Wraps each delivery in a fire-and-forget pattern: errors are logged but never
 * propagate to the caller so a bad subscriber never disrupts the payment flow.
 *
 * @param {string} event  - Event name, e.g. "payment.sent"
 * @param {string} userId - Owner of the event; only that user's webhooks receive it
 * @param {object} data   - Arbitrary event-specific payload data
 * @returns {Promise<void>}
 */
async function deliver(event, userId, data) {
  if (!isValidEvent(event)) {
    throw new Error(`Unknown webhook event "${event}" — add it to services/webhookEvents.js`);
  }
  const { rows } = await db.query(
    `SELECT id, user_id, url, secret, previous_secret, previous_secret_expires_at
     FROM webhooks
     WHERE active = true AND user_id = $2 AND $1 = ANY(events)`,
    [event, userId]
  );

  if (!rows.length) return;

  const payload = {
    event,
    data,
    timestamp: Date.now(),
  };

  const queue = getDeliveryQueue();
  await Promise.all(
    rows.map(async (wh) => {
      if (queue) {
        try {
          // One durable job per (event, subscriber). The secret is loaded by the worker.
          await queue.enqueueDelivery({ webhookId: wh.id, userId, payload });
          return;
        } catch (err) {
          // Redis is down right now: deliver in-process rather than drop the event.
          logger.error('Failed to enqueue webhook delivery, sending in-process', {
            webhookId: wh.id,
            error: err.message,
          });
        }
      }
      await deliverWithRetry(wh.id || null, wh.url, activeSecrets(wh), payload);
    })
  );
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = { id: crypto.randomUUID(), timestamp, event, data };
  await Promise.all(rows.map((wh) => {
    const plainSecret = decryptSecret(wh.secret);
    return deliverWithRetry(wh.id, wh.url, plainSecret, payload);
  }));
}

module.exports = { deliver, sign, retryDelivery, httpsPost, MAX_ATTEMPTS, WEBHOOK_TIMEOUT_MS };
}

module.exports = {
  deliver,
  deliverWithRetry,
  attemptDelivery,
  DeliveryError,
  retryDelivery,
  sign,
  MAX_ATTEMPTS,
};
