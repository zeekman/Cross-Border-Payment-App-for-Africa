/**
 * Ops Alerting
 *
 * Lightweight best-effort notification for conditions that need a human to
 * look (failed on-chain revocations, dead-lettered queue items, etc.).
 * Always logs at 'error' level with alert: true so it's easy to filter/alarm
 * on in the log pipeline. If OPS_ALERT_WEBHOOK_URL is configured, also POSTs
 * a JSON payload there (e.g. a Slack incoming webhook).
 */

const https = require('https');
const logger = require('./logger');

async function notifyOps(event, details = {}) {
  logger.error(`[ALERT] ${event}`, { alert: true, ...details });

  const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const body = JSON.stringify({ text: `[AfriPay ALERT] ${event}`, event, details });
    const { hostname, pathname, search, port, protocol } = new URL(webhookUrl);
    if (protocol !== 'https:') return; // only ever POST over TLS

    await new Promise((resolve) => {
      const req = https.request(
        {
          hostname,
          port: port || 443,
          path: pathname + search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on('error', (err) => {
        logger.warn('Failed to deliver ops alert webhook', { error: err.message });
        resolve();
      });
      req.write(body);
      req.end();
    });
  } catch (err) {
    logger.warn('Failed to deliver ops alert webhook', { error: err.message });
  }
}

module.exports = { notifyOps };
