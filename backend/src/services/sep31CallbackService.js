'use strict';
/**
 * SEP-31 transaction status callback delivery.
 *
 * Mirrors the SSRF hardening used for outbound webhook delivery
 * (see services/webhook.js and __tests__/webhookSsrf.test.js): the callback
 * URL is resolved and validated against the shared utils/ssrf.js allow-list
 * immediately before every delivery attempt (not just once at submission
 * time), and redirects are never auto-followed, so a public URL that later
 * redirects to an internal address cannot be used to reach it.
 */
const logger = require('../utils/logger');
const { validatePublicUrl } = require('../utils/ssrf');

/**
 * Validates a SEP-31 callback_url supplied by a sending anchor/client.
 * Safe to call both at transaction-creation time (reject bad input early)
 * and again right before delivery (resolve-then-validate).
 */
async function validateCallbackUrl(url) {
  return validatePublicUrl(url);
}

const crypto = require('crypto');
const db = require('../db');
const metrics = require('../utils/metrics');

const MAX_ATTEMPTS = 5;

function signPayload(body, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(body));
  return `sha256=${hmac.digest('hex')}`;
}

async function deliverCallback(transaction, attempt = 1) {
  const { id, callback_url, shared_secret, status, status_message, stellar_transaction_id, refunded } = transaction;
  if (!callback_url) return;

  if (!shared_secret) {
    logger.error('SEP-31 callback skipped: missing shared_secret', { txId: id, callback_url });
    metrics.sep31CallbackSkippedTotal.inc({ reason: 'missing_shared_secret' });
    return;
  }

  // Re-validate on every attempt to catch DNS rebinding / stale records.
  if (!(await validateCallbackUrl(callback_url))) {
    logger.error('SEP-31 callback delivery blocked: URL failed SSRF validation', { txId: id, callback_url });
    return;
  }

  const body = { id, status };
  if (status_message) body.status_message = status_message;
  if (stellar_transaction_id) body.stellar_transaction_id = stellar_transaction_id;
  if (refunded) body.refunded = refunded;

  const signature = signPayload(body, shared_secret);
  const start = Date.now();
  let httpStatus = null;

  try {
    const resp = await fetch(callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stellar-Signature': signature,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: 'manual', // never silently follow a redirect to an internal host
    });
    httpStatus = resp.status;
    if (httpStatus >= 300 && httpStatus < 400) {
      logger.error('SEP-31 callback delivery blocked: server returned a redirect', { txId: id, httpStatus });
    }
  } catch (err) {
    logger.warn('SEP-31 callback delivery failed', { txId: id, attempt, error: err.message });
  }

  const responseTimeMs = Date.now() - start;

  await db.query(
    `INSERT INTO sep31_callbacks (transaction_id, url, http_status, response_time_ms, attempt_number)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, callback_url, httpStatus, responseTimeMs, attempt]
  ).catch((err) => logger.warn('Failed to log sep31 callback', { error: err.message }));

  const success = httpStatus && httpStatus >= 200 && httpStatus < 300;
  if (!success && attempt < MAX_ATTEMPTS) {
    const delay = Math.pow(2, attempt) * 1000;
    setTimeout(() => deliverCallback(transaction, attempt + 1), delay);
  }
}

module.exports = { validateCallbackUrl, deliverCallback };
