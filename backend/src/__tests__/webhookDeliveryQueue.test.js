'use strict';

/**
 * BE-217: how services/webhook.js hands deliveries to the durable queue.
 *
 * Also pins the deliver(event, userId, data) contract: a merge had left the
 * implementation as deliver(event, data) while every caller passed a user id,
 * so deliver() threw a ReferenceError that callers' .catch(() => {}) swallowed.
 */

jest.mock('../utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../utils/symmetricEncryption', () => ({ decryptSecret: (s) => s.replace(/^enc:/, ''), encryptSecret: (s) => s }));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../utils/ssrf', () => ({ validateOutboundUrl: jest.fn() }));
jest.mock('../services/webhookQueue', () => ({
  isQueueEnabled: jest.fn(),
  enqueueDelivery: jest.fn(),
}));
jest.mock('https', () => {
  const EventEmitter = require('events');
  let status = 200;
  const request = jest.fn((_options, callback) => {
    const req = new EventEmitter();
    req.write = jest.fn();
    req.end = jest.fn(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.resume = jest.fn();
      callback(res);
    });
    return req;
  });
  return { request, Agent: class {}, __setStatus: (s) => { status = s; } };
});

const https = require('https');
const db = require('../db');
const logger = require('../utils/logger');
const { validateOutboundUrl } = require('../utils/ssrf');
const queue = require('../services/webhookQueue');
const { deliver, retryDelivery, attemptDelivery, DeliveryError } = require('../services/webhook');

const subscriber = (id) => ({
  id,
  user_id: 'u1',
  url: `https://${id}.example.com/hook`,
  secret: 'enc:topsecret',
  previous_secret: null,
  previous_secret_expires_at: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  https.__setStatus(200);
  queue.isQueueEnabled.mockReturnValue(true);
  queue.enqueueDelivery.mockResolvedValue({ id: 'job-1' });
  validateOutboundUrl.mockResolvedValue({ valid: true, agent: undefined });
  db.query.mockResolvedValue({ rows: [{ id: 'delivery-1' }] });
});

describe('deliver(event, userId, data)', () => {
  test('selects only the event owner\'s active webhooks subscribed to the event', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await deliver('payment.sent', 'u1', { id: 'tx1' });

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('user_id = $2'), ['payment.sent', 'u1']);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('active = true'), expect.anything());
  });

  test('enqueues one durable job per subscriber instead of sending in-process', async () => {
    db.query.mockResolvedValue({ rows: [subscriber('w1'), subscriber('w2')] });

    await deliver('payment.sent', 'u1', { amount: '10' });

    expect(queue.enqueueDelivery).toHaveBeenCalledTimes(2);
    expect(queue.enqueueDelivery).toHaveBeenCalledWith({
      webhookId: 'w1',
      userId: 'u1',
      payload: { event: 'payment.sent', data: { amount: '10' }, timestamp: expect.any(Number) },
    });
    expect(https.request).not.toHaveBeenCalled();
  });

  test('never puts a secret in the queue job', async () => {
    db.query.mockResolvedValue({ rows: [subscriber('w1')] });

    await deliver('payment.sent', 'u1', {});

    expect(JSON.stringify(queue.enqueueDelivery.mock.calls)).not.toMatch(/topsecret|secret/i);
  });

  test('every subscriber of one event gets the identical payload and timestamp', async () => {
    db.query.mockResolvedValue({ rows: [subscriber('w1'), subscriber('w2')] });

    await deliver('payment.sent', 'u1', { amount: '10' });

    const [first, second] = queue.enqueueDelivery.mock.calls.map(([job]) => job.payload);
    expect(first).toEqual(second);
  });

  test('falls back to in-process delivery when no queue is running (no REDIS_URL)', async () => {
    queue.isQueueEnabled.mockReturnValue(false);
    db.query.mockImplementation(async (sql) =>
      /FROM webhooks/.test(sql) ? { rows: [subscriber('w1')] } : { rows: [{ id: 'delivery-1' }] }
    );

    await deliver('payment.sent', 'u1', {});

    expect(queue.enqueueDelivery).not.toHaveBeenCalled();
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  test('does not drop the event when Redis is down at enqueue time', async () => {
    queue.enqueueDelivery.mockRejectedValue(new Error('Redis connection lost'));
    db.query.mockImplementation(async (sql) =>
      /FROM webhooks/.test(sql) ? { rows: [subscriber('w1')] } : { rows: [{ id: 'delivery-1' }] }
    );

    await expect(deliver('payment.sent', 'u1', {})).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('enqueue'), expect.objectContaining({ webhookId: 'w1' }));
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  test('rejects an unknown event name', async () => {
    await expect(deliver('not.an.event', 'u1', {})).rejects.toThrow(/Unknown webhook event/);
  });
});

describe('retryDelivery (manual retry)', () => {
  const failedDelivery = (over = {}) => ({
    webhook_id: 'w1',
    target_url: 'https://w1.example.com/hook',
    payload: JSON.stringify({ data: { id: 'tx1' }, timestamp: 5 }),
    event_type: 'payment.sent',
    user_id: 'u1',
    active: true,
    ...subscriber('w1'),
    ...over,
  });

  test('re-enqueues the failed delivery as a durable job', async () => {
    db.query.mockResolvedValue({ rows: [failedDelivery()] });

    await retryDelivery('d1');

    expect(queue.enqueueDelivery).toHaveBeenCalledWith({
      webhookId: 'w1',
      userId: 'u1',
      payload: { data: { id: 'tx1' }, timestamp: 5, event: 'payment.sent' },
    });
    expect(https.request).not.toHaveBeenCalled();
  });

  test('refuses to retry into a disabled endpoint instead of reporting a retry that will never send', async () => {
    db.query.mockResolvedValue({ rows: [failedDelivery({ active: false })] });

    await expect(retryDelivery('d1')).rejects.toThrow(/disabled/);
    expect(queue.enqueueDelivery).not.toHaveBeenCalled();
  });

  test('reports a delivery that does not exist or did not fail', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await expect(retryDelivery('nope')).rejects.toThrow(/not found/);
  });
});

describe('attemptDelivery (one queued attempt)', () => {
  const payload = { event: 'payment.sent', data: { id: 'tx1' }, timestamp: 1 };
  const insertCall = () => db.query.mock.calls.find(([sql]) => /INSERT INTO webhook_deliveries/.test(sql));
  const updateCall = () => db.query.mock.calls.find(([sql]) => /UPDATE webhook_deliveries/.test(sql));

  test('delivers, signs with the secret loaded at send time, and logs the attempt number', async () => {
    const result = await attemptDelivery(subscriber('w1'), payload, 3, 9);

    expect(result).toEqual({ statusCode: 200 });
    const [options] = https.request.mock.calls[0];
    expect(options.headers['X-AfriPay-Signature-256']).toEqual(expect.any(String));
    expect(options.headers['X-AfriPay-Signature-256']).not.toContain('topsecret');
    expect(insertCall()[1].slice(0, 5)).toEqual(['w1', 'payment.sent', 'https://w1.example.com/hook', 3, 9]);
    expect(updateCall()[1][0]).toBe('delivered');
  });

  test('throws a retryable DeliveryError on a non-2xx response and logs it failed', async () => {
    https.__setStatus(503);

    const error = await attemptDelivery(subscriber('w1'), payload, 1, 9).catch((e) => e);

    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('HTTP 503');
    expect(updateCall()[1][0]).toBe('failed');
  });

  test('blocks an SSRF-invalid URL with a non-retryable error and never sends', async () => {
    validateOutboundUrl.mockResolvedValue({ valid: false, error: 'private address' });

    const error = await attemptDelivery(subscriber('w1'), payload, 1, 9).catch((e) => e);

    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.retryable).toBe(false);
    expect(https.request).not.toHaveBeenCalled();
    expect(updateCall()[1][0]).toBe('failed');
  });

  test('a delivery-log write failure never fails the delivery itself', async () => {
    db.query.mockRejectedValue(new Error('db down'));

    await expect(attemptDelivery(subscriber('w1'), payload, 1, 9)).resolves.toEqual({ statusCode: 200 });
  });
});
