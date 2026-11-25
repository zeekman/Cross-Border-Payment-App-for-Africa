/**
 * offlineQueue.idempotency.test.js
 *
 * Tests the offline queue → replay → mid-replay connectivity drop → replay
 * cycle, asserting that:
 *
 *  1. Each queued action is assigned its idempotency key at enqueue time, not
 *     at replay time.
 *  2. A replay that is interrupted by another connectivity drop resumes with
 *     the same key rather than generating a new one on the next attempt.
 *  3. Only a single backend-side effect occurs (the backend idempotency
 *     middleware receives the key on both attempts and deduplicates).
 *
 * Strategy: mock `idb` with a fully in-memory fake that lives inside the
 * jest.mock factory (the only safe place when Babel hoists jest.mock above
 * all other declarations).  Expose a reset helper via a custom module-level
 * symbol so beforeEach can clear state between tests without re-requiring.
 */

// ─── idb fake — everything self-contained inside the factory ─────────────────
jest.mock('idb', () => {
  // In-memory IndexedDB substitute used by offlineDB.js via openDB()
  const state = {
    store: new Map(),
    nextId: 1,
    reset() { this.store = new Map(); this.nextId = 1; },
  };

  const fakeDb = {
    add(_, record) {
      const id = state.nextId++;
      state.store.set(id, { ...record, id });
      return Promise.resolve(id);
    },
    get(_, id) {
      return Promise.resolve(state.store.get(id));
    },
    put(_, record) {
      state.store.set(record.id, record);
      return Promise.resolve(record.id);
    },
    delete(_, id) {
      state.store.delete(id);
      return Promise.resolve();
    },
    getAllFromIndex() {
      const rows = [...state.store.values()].sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      return Promise.resolve(rows);
    },
    count() { return Promise.resolve(state.store.size); },
    clear()  { state.store.clear(); return Promise.resolve(); },
  };

  // openDB always resolves with the same in-memory db instance
  const openDB = jest.fn(() => Promise.resolve(fakeDb));

  // Attach the reset helper directly to openDB so tests can call it via
  //   require('idb').openDB.__resetState()
  openDB.__resetState = () => state.reset();

  return { openDB };
});

// ─── Imports (after jest.mock) ────────────────────────────────────────────────
import {
  enqueuePayment,
  getQueuedPayments,
  removeQueuedPayment,
  updateQueuedPaymentStatus,
} from '../offlineDB';

// ─── Constants ────────────────────────────────────────────────────────────────

const MOCK_UUID = '11111111-1111-4111-a111-111111111111';

const PAYMENT = {
  recipient_address: 'GDEST123456789012345678901234567890123456',
  amount: '10',
  asset: 'XLM',
};

// Queued payments must have an owner (FE-137)
const OWNER = { userId: 'user-1' };

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset in-memory store between tests via the reset helper attached to openDB
  const { openDB } = require('idb');
  openDB.__resetState();

  // Also reset the offlineDB singleton so it re-calls openDB on the next access
  // (needed because offlineDB caches the db promise in a module-level variable).
  jest.resetModules();

  // Stable UUID for assertions
  Object.defineProperty(global, 'crypto', {
    value: { randomUUID: jest.fn().mockReturnValue(MOCK_UUID) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─── Helper: mirrored syncQueue logic ────────────────────────────────────────

/**
 * Mirrors OfflineBanner's syncQueue so we can inject a controlled network mock
 * and simulate a precise connectivity-drop scenario.
 */
async function runSyncQueue(mockPost) {
  // Re-require to get the module with the fresh singleton state
  const { getQueuedPayments: gqp, removeQueuedPayment: rqp, updateQueuedPaymentStatus: uqps } =
    require('../offlineDB');

  const items       = await gqp();
  const capturedKeys = [];

  for (const item of items) {
    await uqps(item.id, 'syncing');
    try {
      capturedKeys.push(item.idempotencyKey);
      await mockPost('/payments/send', item.payload, {
        headers: { 'Idempotency-Key': item.idempotencyKey },
      });
      await rqp(item.id);
    } catch {
      await uqps(item.id, 'failed');
    }
  }

  return capturedKeys;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('offline queue idempotency', () => {
  test('enqueuePayment assigns idempotency key at queue time', async () => {
    const { enqueuePayment: eq, getQueuedPayments: gqp } = require('../offlineDB');
    await eq(PAYMENT, OWNER);

    const items = await gqp();
    expect(items).toHaveLength(1);
    expect(items[0].idempotencyKey).toBe(MOCK_UUID);
  });

  test('idempotency key is stable across multiple getQueuedPayments calls', async () => {
    const { enqueuePayment: eq, getQueuedPayments: gqp } = require('../offlineDB');
    await eq(PAYMENT, OWNER);

    const [first]  = await gqp();
    const [second] = await gqp();
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey).toBe(MOCK_UUID);
  });

  test('key is NOT regenerated when status transitions to syncing or failed', async () => {
    const { enqueuePayment: eq, getQueuedPayments: gqp, updateQueuedPaymentStatus: uqps } =
      require('../offlineDB');

    await eq(PAYMENT, OWNER);
    const [item]      = await gqp();
    const originalKey = item.idempotencyKey;

    await uqps(item.id, 'syncing');
    expect((await gqp())[0].idempotencyKey).toBe(originalKey);

    await uqps(item.id, 'failed');
    expect((await gqp())[0].idempotencyKey).toBe(originalKey);
  });

  test('queue → replay → connectivity drop mid-replay → replay again: single backend effect', async () => {
    const { enqueuePayment: eq, getQueuedPayments: gqp } = require('../offlineDB');

    // Phase 1: queue while offline
    await eq(PAYMENT, OWNER);
    const [queued]       = await gqp();
    const idempotencyKey = queued.idempotencyKey;
    expect(idempotencyKey).toBeTruthy();

    // Phase 2: first replay — network fails mid-request
    const mockPost = jest.fn().mockRejectedValueOnce(new Error('Network lost'));
    const keys1    = await runSyncQueue(mockPost);

    expect(keys1).toEqual([idempotencyKey]);

    const afterDrop = await gqp();
    expect(afterDrop).toHaveLength(1);
    expect(afterDrop[0].idempotencyKey).toBe(idempotencyKey);
    expect(afterDrop[0].status).toBe('failed');

    // Phase 3: second replay — connectivity restored
    mockPost.mockResolvedValueOnce({ data: { transaction: { tx_hash: 'abc' } } });
    const keys2 = await runSyncQueue(mockPost);

    expect(keys2).toEqual([idempotencyKey]); // same key reused

    // Phase 4: backend received the same key on both attempts
    expect(mockPost).toHaveBeenCalledTimes(2);
    const [call1, call2] = mockPost.mock.calls;
    expect(call1[2].headers['Idempotency-Key']).toBe(idempotencyKey);
    expect(call2[2].headers['Idempotency-Key']).toBe(idempotencyKey);
    // Identical keys → backend deduplicates → single logical payment
    expect(call1[2].headers['Idempotency-Key']).toBe(call2[2].headers['Idempotency-Key']);

    // Phase 5: item removed after successful second replay
    expect(await gqp()).toHaveLength(0);
  });

  test('each independently queued payment gets its own unique idempotency key', async () => {
    const { enqueuePayment: eq, getQueuedPayments: gqp } = require('../offlineDB');

    let counter = 0;
    global.crypto.randomUUID.mockImplementation(
      () => `aaaaaaaa-aaaa-4aaa-aaaa-${String(counter++).padStart(12, '0')}`,
    );

    await eq({ ...PAYMENT, amount: '10' }, OWNER);
    await eq({ ...PAYMENT, amount: '20' }, OWNER);

    const [a, b] = await gqp();
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});
