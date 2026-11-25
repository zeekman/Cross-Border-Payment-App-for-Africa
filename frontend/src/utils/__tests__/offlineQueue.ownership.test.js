/**
 * offlineQueue.ownership.test.js
 *
 * FE-137: queued offline payments are bound to the user that created them,
 * expire after QUEUE_TTL_MS, and are never visible to (or replayable by)
 * another user on the same device.
 */

// ─── idb fake — same in-memory substitute as the idempotency tests ───────────
jest.mock('idb', () => {
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
    get(_, id) { return Promise.resolve(state.store.get(id)); },
    put(_, record) {
      state.store.set(record.id, record);
      return Promise.resolve(record.id);
    },
    delete(_, id) {
      state.store.delete(id);
      return Promise.resolve();
    },
    getAllFromIndex() {
      const rows = [...state.store.values()].sort((a, b) => a.createdAt - b.createdAt);
      return Promise.resolve(rows);
    },
    count() { return Promise.resolve(state.store.size); },
    clear() { state.store.clear(); return Promise.resolve(); },
  };

  const openDB = jest.fn(() => Promise.resolve(fakeDb));
  openDB.__resetState = () => state.reset();
  openDB.__rawAdd = (record) => fakeDb.add('queue', record);
  return { openDB };
});

const PAYMENT = {
  recipient_address: 'GDEST123456789012345678901234567890123456',
  amount: '10',
  asset: 'XLM',
};

let db;

beforeEach(() => {
  require('idb').openDB.__resetState();
  jest.resetModules();
  db = require('../offlineDB');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('offline queue ownership (FE-137)', () => {
  test('stores userId, walletId and expiresAt with each entry', async () => {
    const now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await db.enqueuePayment({ ...PAYMENT, wallet_id: 'wallet-a' }, { userId: 'user-a' });

    const [item] = await db.getQueuedPayments();
    expect(item.userId).toBe('user-a');
    expect(item.walletId).toBe('wallet-a');
    expect(item.expiresAt).toBe(now + db.QUEUE_TTL_MS);
  });

  test('uses the current queue owner when no userId is passed', async () => {
    db.setQueueOwner('user-a');
    await db.enqueuePayment(PAYMENT);

    const [item] = await db.getQueuedPayments();
    expect(item.userId).toBe('user-a');
  });

  test('refuses to queue a payment without a logged-in user', async () => {
    db.setQueueOwner(null);
    await expect(db.enqueuePayment(PAYMENT)).rejects.toThrow(/logged-in user/);
    expect(await db.getQueuedPayments()).toHaveLength(0);
  });

  test("a different user never sees another user's queued payments", async () => {
    await db.enqueuePayment({ ...PAYMENT, amount: '10' }, { userId: 'user-a' });
    await db.enqueuePayment({ ...PAYMENT, amount: '20' }, { userId: 'user-b' });

    const forA = await db.getQueuedPaymentsForUser('user-a');
    const forB = await db.getQueuedPaymentsForUser('user-b');

    expect(forA.map((i) => i.payload.amount)).toEqual(['10']);
    expect(forB.map((i) => i.payload.amount)).toEqual(['20']);
    expect(await db.getQueueCountForUser('user-b')).toBe(1);
    expect(await db.getQueuedPaymentsForUser(null)).toEqual([]);
  });

  test('matches owners across number/string ids', async () => {
    await db.enqueuePayment(PAYMENT, { userId: 42 });
    expect(await db.getQueuedPaymentsForUser('42')).toHaveLength(1);
  });

  test('expired entries are not returned for replay', async () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await db.enqueuePayment(PAYMENT, { userId: 'user-a' });

    clock.mockReturnValue(now + db.QUEUE_TTL_MS - 1);
    expect(await db.getQueuedPaymentsForUser('user-a')).toHaveLength(1);

    clock.mockReturnValue(now + db.QUEUE_TTL_MS);
    expect(await db.getQueuedPaymentsForUser('user-a')).toHaveLength(0);
  });

  test('legacy entries without an owner are never returned', async () => {
    await require('idb').openDB.__rawAdd({
      payload: PAYMENT,
      idempotencyKey: 'legacy',
      createdAt: Date.now(),
      status: 'pending',
    });
    expect(await db.getQueuedPaymentsForUser('user-a')).toHaveLength(0);
  });

  test('purgeStaleQueuedPayments removes expired, ownerless and foreign entries', async () => {
    const now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    await db.enqueuePayment({ ...PAYMENT, amount: 'old' }, { userId: 'user-a' });
    clock.mockReturnValue(now + db.QUEUE_TTL_MS + 1);
    await db.enqueuePayment({ ...PAYMENT, amount: 'fresh-a' }, { userId: 'user-a' });
    await db.enqueuePayment({ ...PAYMENT, amount: 'fresh-b' }, { userId: 'user-b' });
    await require('idb').openDB.__rawAdd({
      payload: { ...PAYMENT, amount: 'legacy' },
      idempotencyKey: 'legacy',
      createdAt: Date.now(),
      status: 'pending',
    });

    const removed = await db.purgeStaleQueuedPayments('user-a');

    expect(removed).toBe(3);
    const left = await db.getQueuedPayments();
    expect(left.map((i) => i.payload.amount)).toEqual(['fresh-a']);
  });

  test('clearPaymentQueue removes everything (used on logout)', async () => {
    await db.enqueuePayment(PAYMENT, { userId: 'user-a' });
    await db.enqueuePayment(PAYMENT, { userId: 'user-b' });

    await db.clearPaymentQueue();

    expect(await db.getQueuedPayments()).toHaveLength(0);
  });
});
