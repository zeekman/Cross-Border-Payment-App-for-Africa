'use strict';

/**
 * BE-217 acceptance: "Deliveries survive an API restart".
 *
 * Runs against a real Redis (BullMQ) and is skipped unless TEST_REDIS_URL or
 * REDIS_URL is set, e.g.
 *
 *   TEST_REDIS_URL=redis://localhost:6379 npx jest webhookQueue.integration
 *
 * Only the database and the HTTP attempt are mocked; the queue, the worker, the
 * retries and the backoff are real. The queue name is randomised so a shared
 * Redis is not disturbed.
 */

const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL;
const maybeDescribe = REDIS_URL ? describe : describe.skip;

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/metrics', () => ({
  webhookDeliveriesTotal: { inc: jest.fn() },
  webhookEndpointsDisabledTotal: { inc: jest.fn() },
  webhookQueueDepth: { set: jest.fn() },
}));
jest.mock('../services/webhook', () => ({ attemptDelivery: jest.fn() }));
jest.mock('../services/notificationInbox', () => ({ persistAndBroadcast: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/email', () => ({ enqueueEmail: jest.fn(), escapeHtml: (s) => String(s) }));

const db = require('../db');
const webhook = require('../services/webhook');

const waitFor = async (predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
};

maybeDescribe('webhook queue against real Redis', () => {
  const name = `webhook-delivery-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const row = { id: 'w1', user_id: 'u1', url: 'https://hooks.example.com/h', secret: 'enc:s', active: true };
  const payload = { event: 'payment.sent', data: { id: 'tx1' }, timestamp: 1 };
  let queueModule;
  let standaloneQueue;

  beforeAll(() => {
    process.env.REDIS_URL = REDIS_URL;
    process.env.WEBHOOK_QUEUE_NAME = name;
    process.env.WEBHOOK_RETRY_SCHEDULE = '1s,1s'; // 3 attempts, one second apart
    queueModule = require('../services/webhookQueue');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockImplementation(async (sql) => (/SELECT id, user_id, url, secret/.test(sql) ? { rows: [row] } : { rows: [] }));
  });

  afterAll(async () => {
    await queueModule.drainWebhookQueue();
    const { Queue } = require('bullmq');
    const { Redis } = require('ioredis');
    standaloneQueue = new Queue(name, { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }) });
    await standaloneQueue.obliterate({ force: true });
    await standaloneQueue.close();
  });

  test('a job enqueued while the API was down is delivered after it restarts', async () => {
    webhook.attemptDelivery.mockResolvedValue({ statusCode: 200 });

    // "API process" enqueues, then dies before any worker runs.
    queueModule.initWebhookQueue();
    await queueModule.drainWebhookQueue(); // worker stopped; the queue (Redis) keeps the job
    const { Queue } = require('bullmq');
    const { Redis } = require('ioredis');
    const producer = new Queue(name, {
      connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
      defaultJobOptions: { attempts: 3, backoff: { type: 'custom' } },
    });
    await producer.add('deliver', { webhookId: 'w1', userId: 'u1', payload });
    await producer.close();
    expect(webhook.attemptDelivery).not.toHaveBeenCalled();

    // Restart: a fresh worker picks the job up.
    queueModule.initWebhookQueue();
    await waitFor(() => webhook.attemptDelivery.mock.calls.length === 1);

    expect(webhook.attemptDelivery).toHaveBeenCalledWith(row, payload, 1, 3);
  });

  test('a retry scheduled before a restart still runs after it, as the next attempt', async () => {
    let calls = 0;
    webhook.attemptDelivery.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('HTTP 503');
      return { statusCode: 200 };
    });

    queueModule.initWebhookQueue();
    await queueModule.enqueueDelivery({ webhookId: 'w1', userId: 'u1', payload });
    await waitFor(() => calls === 1); // first attempt failed, retry scheduled in Redis

    await queueModule.drainWebhookQueue(); // restart the API
    queueModule.initWebhookQueue();

    await waitFor(() => calls === 2);
    expect(webhook.attemptDelivery.mock.calls[1][2]).toBe(2); // attempt number
  });
});
