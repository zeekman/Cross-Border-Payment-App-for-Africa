'use strict';

jest.mock('../utils/cache');

const cache = require('../utils/cache');

// In-memory Redis mock
let _store = {};
const mockRedis = {
  rpush:  jest.fn(async (k, v) => { (_store[k] = _store[k] || []).push(v); }),
  lpush:  jest.fn(async (k, v) => { (_store[k] = _store[k] || []).unshift(v); }),
  lpop:   jest.fn(async (k) => { const l = _store[k]; return (l && l.length) ? l.shift() : null; }),
  lrange: jest.fn(async (k) => _store[k] || []),
};
cache.getClient = jest.fn(() => mockRedis);
cache.get = jest.fn().mockResolvedValue(null);
cache.set = jest.fn().mockResolvedValue(undefined);
cache.del = jest.fn().mockResolvedValue(undefined);

const webpush = require('../services/webpush');

// Spy on the exported _sendRaw to avoid crypto/HTTPS
let sendRawSpy;
const SUBSCRIPTION = { endpoint: 'https://push.example.com/sub/1', keys: { p256dh: 'a', auth: 'b' } };
const mockDb = { query: jest.fn().mockResolvedValue({ rows: [] }) };

beforeEach(() => {
  jest.clearAllMocks();
  _store = {};
  Object.assign(mockRedis, {
    rpush:  jest.fn(async (k, v) => { (_store[k] = _store[k] || []).push(v); }),
    lpush:  jest.fn(async (k, v) => { (_store[k] = _store[k] || []).unshift(v); }),
    lpop:   jest.fn(async (k) => { const l = _store[k]; return (l && l.length) ? l.shift() : null; }),
    lrange: jest.fn(async (k) => _store[k] || []),
  });
  cache.getClient.mockReturnValue(mockRedis);
  mockDb.query.mockResolvedValue({ rows: [] });

  // Reset spy
  if (sendRawSpy) sendRawSpy.mockRestore();
  sendRawSpy = jest.spyOn(webpush, '_sendRaw');
});

afterEach(() => { if (sendRawSpy) sendRawSpy.mockRestore(); });

function makeItem(overrides = {}) {
  return {
    subscriptionId: 'user-1', subscription: SUBSCRIPTION,
    payload: '{"type":"test"}', attempt: 1,
    nextRetryAt: Date.now() - 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// processRetryQueue
// ---------------------------------------------------------------------------
describe('processRetryQueue', () => {
  test('successful delivery removes item from queue', async () => {
    sendRawSpy.mockResolvedValue(201);
    _store[webpush.RETRY_QUEUE_KEY] = [JSON.stringify(makeItem())];
    await webpush.processRetryQueue(mockDb);
    expect(_store[webpush.RETRY_QUEUE_KEY] || []).toHaveLength(0);
    expect(_store[webpush.DEAD_LETTER_KEY]  || []).toHaveLength(0);
  });

  test('re-queues with attempt+1 on transient failure (503)', async () => {
    const err = Object.assign(new Error('503'), { statusCode: 503 });
    sendRawSpy.mockRejectedValue(err);
    _store[webpush.RETRY_QUEUE_KEY] = [JSON.stringify(makeItem({ attempt: 1 }))];
    await webpush.processRetryQueue(mockDb);
    expect(_store[webpush.RETRY_QUEUE_KEY]).toHaveLength(1);
    expect(JSON.parse(_store[webpush.RETRY_QUEUE_KEY][0]).attempt).toBe(2);
  });

  test('moves to dead-letter after MAX_ATTEMPTS exhausted', async () => {
    const err = Object.assign(new Error('503'), { statusCode: 503 });
    sendRawSpy.mockRejectedValue(err);
    _store[webpush.RETRY_QUEUE_KEY] = [JSON.stringify(makeItem({ attempt: webpush.MAX_ATTEMPTS }))];
    await webpush.processRetryQueue(mockDb);
    expect(_store[webpush.DEAD_LETTER_KEY]).toHaveLength(1);
    expect(_store[webpush.RETRY_QUEUE_KEY] || []).toHaveLength(0);
    expect(JSON.parse(_store[webpush.DEAD_LETTER_KEY][0]).error).toBeDefined();
  });

  test('cleans up DB subscription on 410 during retry', async () => {
    const err = Object.assign(new Error('410'), { statusCode: 410 });
    sendRawSpy.mockRejectedValue(err);
    _store[webpush.RETRY_QUEUE_KEY] = [JSON.stringify(makeItem({ subscriptionId: 'gone-user' }))];
    await webpush.processRetryQueue(mockDb);
    expect(mockDb.query).toHaveBeenCalledWith(
      'UPDATE users SET push_subscription_active = false WHERE id = $1', ['gone-user']
    );
    expect(_store[webpush.DEAD_LETTER_KEY] || []).toHaveLength(0);
    expect(_store[webpush.RETRY_QUEUE_KEY] || []).toHaveLength(0);
  });

  test('respects Retry-After header on 429', async () => {
    const err = Object.assign(new Error('429'), { statusCode: 429, retryAfter: 120 });
    sendRawSpy.mockRejectedValue(err);
    const now = Date.now();
    _store[webpush.RETRY_QUEUE_KEY] = [JSON.stringify(makeItem())];
    await webpush.processRetryQueue(mockDb);
    const requeued = JSON.parse(_store[webpush.RETRY_QUEUE_KEY][0]);
    expect(requeued.nextRetryAt).toBeGreaterThan(now + 115_000);
    expect(requeued.nextRetryAt).toBeLessThan(now + 125_000);
  });

  test('skips item not yet due', async () => {
    sendRawSpy.mockResolvedValue(201);
    const future = makeItem({ nextRetryAt: Date.now() + 60_000 });
    _store[webpush.RETRY_QUEUE_KEY] = [JSON.stringify(future)];
    await webpush.processRetryQueue(mockDb);
    expect(_store[webpush.RETRY_QUEUE_KEY]).toHaveLength(1);
    expect(sendRawSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getDeadLetter
// ---------------------------------------------------------------------------
describe('getDeadLetter', () => {
  test('returns items from dead-letter list', async () => {
    _store[webpush.DEAD_LETTER_KEY] = [JSON.stringify({ subscriptionId: 'u1', error: 'fail' })];
    expect(await webpush.getDeadLetter()).toHaveLength(1);
  });

  test('returns empty array when list is empty', async () => {
    expect(await webpush.getDeadLetter()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sendNotification — uses _sendRaw spy
// ---------------------------------------------------------------------------
describe('sendNotification', () => {
  test('returns status on successful delivery', async () => {
    sendRawSpy.mockResolvedValue(201);
    const status = await webpush.sendNotification(SUBSCRIPTION, '{}', 'u1', mockDb);
    expect(status).toBe(201);
  });

  test('deactivates subscription on 410 Gone', async () => {
    const err = Object.assign(new Error('410'), { statusCode: 410 });
    sendRawSpy.mockRejectedValue(err);
    const status = await webpush.sendNotification(SUBSCRIPTION, '{}', 'u-gone', mockDb);
    expect(status).toBe(410);
    expect(mockDb.query).toHaveBeenCalledWith(
      'UPDATE users SET push_subscription_active = false WHERE id = $1', ['u-gone']
    );
    expect(mockRedis.rpush).not.toHaveBeenCalled();
  });

  test('enqueues retry on 500 then rethrows', async () => {
    const err = Object.assign(new Error('500'), { statusCode: 500 });
    sendRawSpy.mockRejectedValue(err);
    await expect(webpush.sendNotification(SUBSCRIPTION, '{}', 'u-retry', mockDb))
      .rejects.toMatchObject({ statusCode: 500 });
    expect(mockRedis.rpush).toHaveBeenCalledWith(
      webpush.RETRY_QUEUE_KEY, expect.stringContaining('"attempt":1')
    );
  });
});
