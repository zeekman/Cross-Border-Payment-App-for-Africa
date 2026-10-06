/**
 * offlineDB.js
 *
 * Thin IndexedDB layer (via `idb`) for AfriPay offline mode.
 *
 * Stores:
 *  - "cache"   : last-known API snapshots  (balance, transaction history)
 *  - "queue"   : outgoing payment requests that failed while offline
 *
 * The service worker handles Background Sync replay automatically.
 * This module is used by React components to read cached data and
 * to let the UI display the pending-payment queue to the user.
 */

import { openDB } from 'idb';

/**
 * Generate a RFC-4122 v4 UUID.
 * Uses `crypto.randomUUID()` when available (all modern browsers), falling back
 * to a manual implementation so the module works in test environments.
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Polyfill: manually assemble a v4 UUID from random bytes
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DB_NAME    = 'afripay-offline';
const DB_VERSION = 1;

/** Lazily-opened singleton promise */
let _db = null;

function getDB() {
  if (_db) return _db;
  _db = openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Key-value store for API snapshots
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache');
      }
      // Ordered store for queued payment requests
      if (!db.objectStoreNames.contains('queue')) {
        const store = db.createObjectStore('queue', {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('by_created', 'createdAt');
      }
    },
  });
  return _db;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

/**
 * Persist an API response snapshot.
 * @param {string} key   - e.g. 'balance' | 'history'
 * @param {*}      value - serialisable JS value
 */
export async function setCacheEntry(key, value) {
  const db = await getDB();
  await db.put('cache', { data: value, savedAt: Date.now() }, key);
}

/**
 * Read a cached snapshot.
 * @param {string} key
 * @returns {{ data: *, savedAt: number } | undefined}
 */
export async function getCacheEntry(key) {
  const db = await getDB();
  return db.get('cache', key);
}

// ─── Payment queue helpers ────────────────────────────────────────────────────

/**
 * Queued payments older than this are never replayed (FE-137). Exchange rates
 * and balances drift, so a payment the user intended hours ago must not be
 * executed silently days later.
 */
export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Id of the currently logged-in user. Set by AuthContext on login / session
 * restore and cleared on logout, so the api.js offline interceptor can stamp
 * each queued payment with its owner without importing React context.
 */
let _queueOwnerId = null;

/** @param {string|number|null} userId */
export function setQueueOwner(userId) {
  _queueOwnerId = userId ?? null;
}

/** @returns {string|number|null} */
export function getQueueOwner() {
  return _queueOwnerId;
}

function isExpired(entry, now = Date.now()) {
  const expiresAt = entry.expiresAt ?? (entry.createdAt + QUEUE_TTL_MS);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function isOwnedBy(entry, userId) {
  return userId != null && entry.userId != null && String(entry.userId) === String(userId);
}

/**
 * Add a payment to the offline queue.
 *
 * An idempotency key is generated **once** at queue time and stored alongside
 * the payload.  Every subsequent replay attempt (including resumptions after a
 * mid-replay connectivity drop) must reuse the same key so that the backend
 * idempotency middleware can deduplicate the request and prevent duplicate
 * payments.
 *
 * Every entry is bound to the user (and wallet) that created it so it can only
 * ever be replayed by that same user (FE-137). Queuing without a known owner
 * is refused rather than creating an entry any later session could send.
 *
 * @param {{ recipient_address: string, amount: string, asset: string, memo?: string, memo_type?: string, wallet_id?: string }} payload
 * @param {{ userId?: string|number }} [options] - defaults to the current queue owner
 * @returns {Promise<IDBValidKey>} The auto-incremented id of the new queue entry
 */
export async function enqueuePayment(payload, { userId = _queueOwnerId } = {}) {
  if (userId == null) {
    throw new Error('Cannot queue an offline payment without a logged-in user');
  }
  const db = await getDB();
  const createdAt = Date.now();
  return db.add('queue', {
    payload,
    userId,
    walletId: payload?.wallet_id ?? null,
    idempotencyKey: generateUUID(), // assigned once, never regenerated on replay
    createdAt,
    expiresAt: createdAt + QUEUE_TTL_MS,
    status: 'pending',   // 'pending' | 'syncing' | 'failed'
  });
}

/**
 * Update the status of a queued payment without replacing its idempotency key.
 * Used by the replay logic to mark items as 'syncing' or 'failed' between
 * connectivity changes so the key is never discarded mid-flight.
 *
 * @param {number} id - The auto-incremented queue entry id
 * @param {'pending'|'syncing'|'failed'} status
 */
export async function updateQueuedPaymentStatus(id, status) {
  const db = await getDB();
  const entry = await db.get('queue', id);
  if (!entry) return;
  await db.put('queue', { ...entry, status });
}

/**
 * Return all queued payments, oldest first.
 * @returns {Promise<Array>}
 */
export async function getQueuedPayments() {
  const db = await getDB();
  return db.getAllFromIndex('queue', 'by_created');
}

/**
 * Return the non-expired queued payments that belong to `userId`, oldest
 * first. Entries from other users, entries without an owner (queued before
 * FE-137) and expired entries are never returned, so they can't be replayed.
 *
 * @param {string|number} userId
 * @returns {Promise<Array>}
 */
export async function getQueuedPaymentsForUser(userId) {
  if (userId == null) return [];
  const now = Date.now();
  const items = await getQueuedPayments();
  return items.filter((item) => isOwnedBy(item, userId) && !isExpired(item, now));
}

/**
 * Number of replayable queued payments for `userId`.
 * @param {string|number} userId
 * @returns {Promise<number>}
 */
export async function getQueueCountForUser(userId) {
  return (await getQueuedPaymentsForUser(userId)).length;
}

/**
 * Delete expired entries, entries with no owner, and — when `userId` is given —
 * entries that belong to any other user. Called when a user session starts so
 * a previous user's pending payments never linger on a shared device.
 *
 * @param {string|number} [userId]
 * @returns {Promise<number>} number of entries removed
 */
export async function purgeStaleQueuedPayments(userId) {
  const db = await getDB();
  const now = Date.now();
  const items = await getQueuedPayments();
  const stale = items.filter(
    (item) =>
      isExpired(item, now) ||
      item.userId == null ||
      (userId != null && !isOwnedBy(item, userId))
  );
  await Promise.all(stale.map((item) => db.delete('queue', item.id)));
  return stale.length;
}

/**
 * Remove a queued payment by its auto-incremented id.
 * @param {number} id
 */
export async function removeQueuedPayment(id) {
  const db = await getDB();
  await db.delete('queue', id);
}

/**
 * Clear every entry in the payment queue (e.g. on logout, so the next user of
 * the device never inherits pending payments).
 */
export async function clearPaymentQueue() {
  const db = await getDB();
  await db.clear('queue');
}

/**
 * Return the number of payments currently queued.
 * @returns {Promise<number>}
 */
export async function getQueueCount() {
  const db = await getDB();
  return db.count('queue');
}
