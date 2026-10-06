/**
 * Single catalogue of webhook event types emitted by the backend.
 * Used by both emitters (webhook.deliver) and subscription validation.
 *
 * Payloads:
 *  - payment.sent / payment.received: { tx_hash, amount, asset, sender, recipient, ... }
 *  - payment.failed: { error, ... }
 *  - escrow.cancelled: { escrow_id, tx_hash, ... }
 *  - claimable_balance.expired: { balance_id, amount, asset, ... }
 *  - claimable_balance.expiring_soon: { balance_id, amount, asset, expires_at, ... }
 */
const WEBHOOK_EVENTS = Object.freeze([
  'payment.sent',
  'payment.received',
  'payment.failed',
  'escrow.cancelled',
  'claimable_balance.expired',
  'claimable_balance.expiring_soon',
]);

const isValidEvent = (e) => WEBHOOK_EVENTS.includes(e);

module.exports = { WEBHOOK_EVENTS, isValidEvent };
