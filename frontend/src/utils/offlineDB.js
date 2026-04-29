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
 * Add a payment to the offline queue.
 * @param {{ recipient_address: string, amount: string, asset: string, memo?: string, memo_type?: string }} payload
 */
export async function enqueuePayment(payload) {
  const db = await getDB();
  await db.add('queue', {
    payload,
    createdAt: Date.now(),
    status: 'pending',   // 'pending' | 'syncing' | 'failed'
  });
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
 * Remove a queued payment by its auto-incremented id.
 * @param {number} id
 */
export async function removeQueuedPayment(id) {
  const db = await getDB();
  await db.delete('queue', id);
}

/**
 * Clear every entry in the payment queue (e.g. after a successful bulk sync).
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
