'use strict';

/**
 * BE-217: durable webhook delivery (services/webhookQueue.js).
 *
 * Unit tests with BullMQ, the database and the delivery attempt mocked. The
 * restart-survival test against a real queue is in webhookQueue.integration.test.js.
 */

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/metrics', () => ({
  webhookDeliveriesTotal: { inc: jest.fn() },
  webhookEndpointsDisabledTotal: { inc: jest.fn() },
  webhookQueueDepth: { set: jest.fn() },
}));
jest.mock('../services/webhook', () => ({ attemptDelivery: jest.fn() }));
jest.mock('../services/notificationInbox', () => ({ persistAndBroadcast: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/email', () => ({
  enqueueEmail: jest.fn().mockResolvedValue(undefined),
  escapeHtml: (s) => String(s),
}));
jest.mock('ioredis', () => ({ Redis: jest.fn() }));
jest.mock('bullmq', () => {
  class UnrecoverableError extends Error {
    constructor(message) {
      super(message);
      this.name = 'UnrecoverableError';
    }
  }
  return { UnrecoverableError, Queue: jest.fn(), Worker: jest.fn() };
});

const bullmq = require('bullmq');
const db = require('../db');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const webhook = require('../services/webhook');
const { persistAndBroadcast } = require('../services/notificationInbox');
const { enqueueEmail } = require('../services/email');
const queueModule = require('../services/webhookQueue');

const HOUR = 3_600_000;

const webhookRow = {
  id: 'w1',
  user_id: 'u1',
  url: 'https://hooks.example.com/path?token=SECRET_IN_URL',
  secret: 'enc:topsecret',
  active: true,
};

const makeJob = (over = {}) => ({
  id: 'job-1',
  data: { webhookId: 'w1', userId: 'u1', payload: { event: 'payment.sent', data: { id: 'tx1' }, timestamp: 1 } },
  attemptsMade: 0,
  opts: { attempts: 9 },
  ...over,
});

/** Route db.query by statement so each test states only what differs. */
function routeDb({ webhook: row = webhookRow, failureRow, disableRows = [{ id: 'w1' }], email = 'owner@example.com' } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/SELECT id, user_id, url, secret/.test(sql)) return { rows: row ? [row] : [] };
    if (/SET consecutive_failures = consecutive_failures \+ 1/.test(sql)) return { rows: failureRow ? [failureRow] : [] };
    if (/SET consecutive_failures = 0/.test(sql)) return { rows: [] };
    if (/SET active = false/.test(sql)) return { rows: disableRows };
    if (/SELECT email FROM users/.test(sql)) return { rows: email ? [{ email }] : [] };
    return { rows: [] };
  });
}

const sqlCalls = (pattern) => db.query.mock.calls.filter(([sql]) => pattern.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  persistAndBroadcast.mockResolvedValue(undefined);
  enqueueEmail.mockResolvedValue(undefined);
  delete process.env.REDIS_URL;
  delete process.env.WEBHOOK_RETRY_SCHEDULE;
  delete process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES;
  delete process.env.WEBHOOK_WORKER_CONCURRENCY;
});

// ── Backoff schedule ─────────────────────────────────────────────────────────

describe('parseDuration', () => {
  test.each([
    ['30s', 30_000],
    ['5m', 300_000],
    ['2h', 2 * HOUR],
    ['1d', 24 * HOUR],
    ['10S', 10_000],
  ])('%s', (token, ms) => expect(queueModule.parseDuration(token)).toBe(ms));

  test.each(['10', 'abc', '0s', '-5m', '1.5h', '', '5 m', '5w'])('rejects %p', (token) => {
    expect(queueModule.parseDuration(token)).toBeNull();
  });
});

describe('parseBackoffSchedule', () => {
  test('default is 8 retries spread over about two days', () => {
    const schedule = queueModule.parseBackoffSchedule(undefined);
    expect(schedule).toEqual([10_000, 60_000, 300_000, 1_800_000, 2 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]);
    const total = schedule.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(40 * HOUR);
    expect(total).toBeLessThan(48 * HOUR);
  });

  test('accepts a custom schedule', () => {
    expect(queueModule.parseBackoffSchedule('1s, 2m ,3h')).toEqual([1000, 120_000, 3 * HOUR]);
  });

  test.each(['', '   ', '10s,abc', '10s,,1m', '30', ',', '10s,1m,'])('falls back to the default for %p', (raw) => {
    expect(queueModule.parseBackoffSchedule(raw)).toEqual(queueModule.parseBackoffSchedule(undefined));
  });

  test('warns when a configured value is invalid', () => {
    queueModule.parseBackoffSchedule('10s,nope');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_RETRY_SCHEDULE'), expect.anything());
  });

  test('rejects an absurdly long schedule', () => {
    const raw = Array.from({ length: 21 }, () => '1m').join(',');
    expect(queueModule.parseBackoffSchedule(raw)).toEqual(queueModule.parseBackoffSchedule(undefined));
  });
});

describe('getWebhookConfig', () => {
  test('defaults: 9 attempts, disable after 5 failed events, concurrency 5', () => {
    expect(queueModule.getWebhookConfig({})).toMatchObject({
      attempts: 9,
      maxConsecutiveFailures: 5,
      concurrency: 5,
    });
  });

  test('is configurable from the environment', () => {
    const config = queueModule.getWebhookConfig({
      WEBHOOK_RETRY_SCHEDULE: '5s,30s',
      WEBHOOK_MAX_CONSECUTIVE_FAILURES: '3',
      WEBHOOK_WORKER_CONCURRENCY: '10',
    });
    expect(config).toEqual({ backoffMs: [5000, 30_000], attempts: 3, maxConsecutiveFailures: 3, concurrency: 10 });
  });

  test.each(['0', '-1', 'abc', '2.5', ''])('ignores invalid counts (%p)', (raw) => {
    expect(
      queueModule.getWebhookConfig({ WEBHOOK_MAX_CONSECUTIVE_FAILURES: raw, WEBHOOK_WORKER_CONCURRENCY: raw })
    ).toMatchObject({ maxConsecutiveFailures: 5, concurrency: 5 });
  });
});

describe('backoffDelayMs', () => {
  const schedule = [10_000, 60_000, 300_000];

  test('uses the delay for the attempt that just failed', () => {
    expect(queueModule.backoffDelayMs(1, schedule)).toBe(10_000);
    expect(queueModule.backoffDelayMs(2, schedule)).toBe(60_000);
    expect(queueModule.backoffDelayMs(3, schedule)).toBe(300_000);
  });

  test('stays on the last delay if asked for more', () => {
    expect(queueModule.backoffDelayMs(9, schedule)).toBe(300_000);
    expect(queueModule.backoffDelayMs(0, schedule)).toBe(10_000);
  });
});

// ── Worker: one attempt per job ──────────────────────────────────────────────

describe('processWebhookJob', () => {
  test('loads the webhook (and its secret) from the database at send time', async () => {
    routeDb();
    webhook.attemptDelivery.mockResolvedValue({ statusCode: 200 });

    await queueModule.processWebhookJob(makeJob());

    expect(sqlCalls(/SELECT id, user_id, url, secret/)[0][1]).toEqual(['w1']);
    expect(webhook.attemptDelivery).toHaveBeenCalledWith(webhookRow, makeJob().data.payload, 1, 9);
  });

  test('numbers the attempt from BullMQ attemptsMade', async () => {
    routeDb();
    webhook.attemptDelivery.mockResolvedValue({ statusCode: 200 });

    await queueModule.processWebhookJob(makeJob({ attemptsMade: 3 }));

    expect(webhook.attemptDelivery).toHaveBeenCalledWith(webhookRow, expect.anything(), 4, 9);
  });

  test('success resets the failure streak and counts a delivery', async () => {
    routeDb();
    webhook.attemptDelivery.mockResolvedValue({ statusCode: 204 });

    await expect(queueModule.processWebhookJob(makeJob())).resolves.toEqual({ statusCode: 204 });

    expect(sqlCalls(/SET consecutive_failures = 0/)).toHaveLength(1);
    expect(metrics.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({ result: 'delivered' });
  });

  test('skips an endpoint that was deleted or disabled meanwhile', async () => {
    for (const row of [null, { ...webhookRow, active: false }]) {
      jest.clearAllMocks();
      routeDb({ webhook: row });

      await expect(queueModule.processWebhookJob(makeJob())).resolves.toEqual({ skipped: true });

      expect(webhook.attemptDelivery).not.toHaveBeenCalled();
      expect(metrics.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({ result: 'skipped' });
    }
  });

  test('rethrows a retryable failure so the queue schedules the next attempt', async () => {
    routeDb();
    const failure = new Error('HTTP 503');
    webhook.attemptDelivery.mockRejectedValue(failure);

    await expect(queueModule.processWebhookJob(makeJob())).rejects.toBe(failure);
    expect(sqlCalls(/SET consecutive_failures = 0/)).toHaveLength(0);
  });

  test('turns a non-retryable failure into an UnrecoverableError so retries stop', async () => {
    routeDb();
    const blocked = Object.assign(new Error('SSRF validation failed'), { retryable: false });
    webhook.attemptDelivery.mockRejectedValue(blocked);

    await expect(queueModule.processWebhookJob(makeJob())).rejects.toBeInstanceOf(bullmq.UnrecoverableError);
  });
});

// ── Failure handling: notify, count, auto-disable ────────────────────────────

describe('onJobFailed', () => {
  const config = { maxConsecutiveFailures: 3 };

  test('a failure with attempts left only counts a retry, with no database writes', async () => {
    routeDb();

    await queueModule.onJobFailed(makeJob({ attemptsMade: 2 }), new Error('HTTP 500'), config);

    expect(metrics.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({ result: 'retry' });
    expect(db.query).not.toHaveBeenCalled();
    expect(persistAndBroadcast).not.toHaveBeenCalled();
  });

  test('exhausting every attempt marks the event failed and notifies the owner in-app and by email', async () => {
    routeDb({ failureRow: { id: 'w1', user_id: 'u1', url: webhookRow.url, active: true, consecutive_failures: 1 } });

    await queueModule.onJobFailed(makeJob({ attemptsMade: 9 }), new Error('HTTP 500'), config);

    expect(metrics.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({ result: 'failed' });
    expect(sqlCalls(/consecutive_failures \+ 1/)).toHaveLength(1);
    expect(persistAndBroadcast).toHaveBeenCalledWith(
      'u1',
      'webhook_delivery_failed',
      'Webhook delivery failed',
      expect.stringContaining('payment.sent'),
      expect.objectContaining({ webhook_id: 'w1' })
    );
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com' }));
    // Below the threshold: still enabled.
    expect(sqlCalls(/SET active = false/)).toHaveLength(0);
  });

  test('notifications name the host only, never the full URL or its token', async () => {
    routeDb({ failureRow: { id: 'w1', user_id: 'u1', url: webhookRow.url, active: true, consecutive_failures: 1 } });

    await queueModule.onJobFailed(makeJob({ attemptsMade: 9 }), new Error('HTTP 500'), config);

    const body = persistAndBroadcast.mock.calls[0][3];
    expect(body).toContain('hooks.example.com');
    expect(body).not.toContain('SECRET_IN_URL');
    expect(JSON.stringify(persistAndBroadcast.mock.calls)).not.toContain('topsecret');
  });

  test('disables the endpoint once the failure streak reaches the threshold, and says so', async () => {
    routeDb({ failureRow: { id: 'w1', user_id: 'u1', url: webhookRow.url, active: true, consecutive_failures: 3 } });

    await queueModule.onJobFailed(makeJob({ attemptsMade: 9 }), new Error('HTTP 500'), config);

    const disable = sqlCalls(/SET active = false/);
    expect(disable).toHaveLength(1);
    expect(disable[0][1][0]).toBe('w1');
    expect(disable[0][1][1]).toContain('3 consecutive failed events');
    expect(metrics.webhookEndpointsDisabledTotal.inc).toHaveBeenCalledTimes(1);
    expect(persistAndBroadcast).toHaveBeenCalledWith(
      'u1',
      'webhook_endpoint_disabled',
      'Webhook endpoint disabled',
      expect.stringContaining('re-enable'),
      expect.objectContaining({ consecutive_failures: 3 })
    );
  });

  test('does not disable twice or notify again if it was already disabled', async () => {
    routeDb({
      failureRow: { id: 'w1', user_id: 'u1', url: webhookRow.url, active: false, consecutive_failures: 7 },
    });

    await queueModule.onJobFailed(makeJob({ attemptsMade: 9 }), new Error('HTTP 500'), config);

    expect(sqlCalls(/SET active = false/)).toHaveLength(0);
    expect(metrics.webhookEndpointsDisabledTotal.inc).not.toHaveBeenCalled();
  });

  test('loses the race gracefully when another worker disables the endpoint first', async () => {
    routeDb({
      failureRow: { id: 'w1', user_id: 'u1', url: webhookRow.url, active: true, consecutive_failures: 3 },
      disableRows: [],
    });

    await queueModule.onJobFailed(makeJob({ attemptsMade: 9 }), new Error('HTTP 500'), config);

    expect(metrics.webhookEndpointsDisabledTotal.inc).not.toHaveBeenCalled();
    expect(persistAndBroadcast).not.toHaveBeenCalledWith('u1', 'webhook_endpoint_disabled', expect.anything(), expect.anything(), expect.anything());
  });

  test('an unrecoverable error is a permanent failure even with attempts left', async () => {
    routeDb({ failureRow: { id: 'w1', user_id: 'u1', url: webhookRow.url, active: true, consecutive_failures: 1 } });

    await queueModule.onJobFailed(makeJob({ attemptsMade: 1 }), new bullmq.UnrecoverableError('SSRF validation failed'), config);

    expect(metrics.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({ result: 'failed' });
    expect(sqlCalls(/consecutive_failures \+ 1/)).toHaveLength(1);
  });

  test('a deleted webhook is ignored without notifying anyone', async () => {
    routeDb({ failureRow: null });

    await queueModule.onJobFailed(makeJob({ attemptsMade: 9 }), new Error('HTTP 500'), config);

    expect(persistAndBroadcast).not.toHaveBeenCalled();
  });

  test('a notification failure never breaks failure handling', async () => {
    routeDb({ failureRow: { id: 'w1', user_id: 'u1', url: webhookRow.url, active: true, consecutive_failures: 3 } });
    persistAndBroadcast.mockRejectedValue(new Error('db down'));
    enqueueEmail.mockRejectedValue(new Error('smtp down'));

    await expect(queueModule.onJobFailed(makeJob({ attemptsMade: 9 }), new Error('HTTP 500'), config)).resolves.toBeUndefined();
    expect(sqlCalls(/SET active = false/)).toHaveLength(1);
  });

  test('skips the email when the owner has no address', async () => {
    routeDb({
      failureRow: { id: 'w1', user_id: 'u1', url: webhookRow.url, active: true, consecutive_failures: 1 },
      email: null,
    });

    await queueModule.onJobFailed(makeJob({ attemptsMade: 9 }), new Error('HTTP 500'), config);

    expect(enqueueEmail).not.toHaveBeenCalled();
  });
});

// ── Queue setup ──────────────────────────────────────────────────────────────

describe('queue lifecycle', () => {
  const close = jest.fn().mockResolvedValue(undefined);
  let queueInstance;
  let workerInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    queueInstance = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 2, active: 1, delayed: 5, failed: 0 }),
      close,
    };
    workerInstance = { on: jest.fn(), close };
    bullmq.Queue.mockImplementation(() => queueInstance);
    bullmq.Worker.mockImplementation(() => workerInstance);
  });

  afterEach(async () => {
    await queueModule.drainWebhookQueue();
    jest.useRealTimers();
  });

  test('is disabled without REDIS_URL, so webhook.js falls back to in-process retries', () => {
    expect(queueModule.initWebhookQueue()).toBeNull();
    expect(queueModule.isQueueEnabled()).toBe(false);
    expect(bullmq.Queue).not.toHaveBeenCalled();
  });

  test('refuses to enqueue when the queue is not running', async () => {
    await expect(queueModule.enqueueDelivery({ webhookId: 'w1', userId: 'u1', payload: {} })).rejects.toThrow(
      /not running/
    );
  });

  test('creates a queue that retries over the configured schedule with custom backoff', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.WEBHOOK_RETRY_SCHEDULE = '10s,1m,5m';

    queueModule.initWebhookQueue();

    expect(queueModule.isQueueEnabled()).toBe(true);
    const [name, options] = bullmq.Queue.mock.calls[0];
    expect(name).toBe('webhook-delivery');
    expect(options.defaultJobOptions).toMatchObject({ attempts: 4, backoff: { type: 'custom' } });
  });

  test('the worker backs off along the schedule and honours the concurrency setting', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.WEBHOOK_RETRY_SCHEDULE = '10s,1m,5m';
    process.env.WEBHOOK_WORKER_CONCURRENCY = '7';

    queueModule.initWebhookQueue();

    const [, handler, options] = bullmq.Worker.mock.calls[0];
    expect(handler).toBe(queueModule.processWebhookJob);
    expect(options.concurrency).toBe(7);
    expect(options.settings.backoffStrategy(1)).toBe(10_000);
    expect(options.settings.backoffStrategy(2)).toBe(60_000);
    expect(options.settings.backoffStrategy(3)).toBe(300_000);
  });

  test('enqueues one job per delivery and the job carries no secret', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    queueModule.initWebhookQueue();

    await queueModule.enqueueDelivery({ webhookId: 'w1', userId: 'u1', payload: { event: 'payment.sent' } });

    expect(queueInstance.add).toHaveBeenCalledWith('deliver', {
      webhookId: 'w1',
      userId: 'u1',
      payload: { event: 'payment.sent' },
    });
    expect(JSON.stringify(queueInstance.add.mock.calls)).not.toMatch(/secret/i);
  });

  test('routes worker failures to the failure handler', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    queueModule.initWebhookQueue();

    const failedHandler = workerInstance.on.mock.calls.find(([event]) => event === 'failed')[1];
    routeDb();
    failedHandler(makeJob({ attemptsMade: 2 }), new Error('HTTP 500'));
    await Promise.resolve();

    expect(metrics.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({ result: 'retry' });
  });

  test('exports queue depth by state, at startup and on a timer', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    queueModule.initWebhookQueue();
    await jest.advanceTimersByTimeAsync(0);

    expect(metrics.webhookQueueDepth.set).toHaveBeenCalledWith({ state: 'waiting' }, 2);
    expect(metrics.webhookQueueDepth.set).toHaveBeenCalledWith({ state: 'delayed' }, 5);
    expect(metrics.webhookQueueDepth.set).toHaveBeenCalledWith({ state: 'active' }, 1);

    queueInstance.getJobCounts.mockResolvedValue({ waiting: 9, active: 0, delayed: 0, failed: 1 });
    await jest.advanceTimersByTimeAsync(15_000);
    expect(metrics.webhookQueueDepth.set).toHaveBeenCalledWith({ state: 'waiting' }, 9);
  });

  test('drain closes the worker and the queue', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    queueModule.initWebhookQueue();

    await queueModule.drainWebhookQueue();

    expect(close).toHaveBeenCalledTimes(2);
    expect(queueModule.isQueueEnabled()).toBe(false);
  });
});
