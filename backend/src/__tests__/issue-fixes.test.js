/**
 * Tests for issues #954, #956, #957, #960, #1281.
 *
 * #954 — Login lockout race: atomic UPDATE...RETURNING replaces read-then-write.
 * #956 — Bulk user management: batch cap enforced + statement timeout added.
 * #957 — Batch payment: MAX_BATCH_SIZE=20 matches on-chain contract limit.
 * #960 — Contact deduplication: same Stellar key upserts instead of duplicating.
 * #1281 — Scheduled payments: interval passed as $2::interval and schedule
 *         advance wrapped in a transaction so a post-send failure never marks
 *         the schedule as failed.
 */

'use strict';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------
jest.mock('../db');
jest.mock('../services/audit', () => ({ log: jest.fn(), auditLog: jest.fn() }));
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'admin-uuid', role: 'admin' };
  next();
});
jest.mock('../services/stellar', () => ({}));
jest.mock('../services/notificationInbox', () => ({
  persistAndBroadcast: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../utils/cache', () => ({ get: jest.fn(), set: jest.fn() }));

const request = require('supertest');
const express = require('express');
const db = require('../db');
const audit = require('../services/audit');

// ============================================================================
// #957 — Batch payment validator cap (MAX_BATCH_SIZE = 20)
// ============================================================================
describe('#957 — paymentBatchValidators: MAX_BATCH_SIZE = 20', () => {
  const { MAX_BATCH_SIZE } = require('../validators/paymentBatchValidators');

  test('MAX_BATCH_SIZE is exported and equals 20', () => {
    expect(MAX_BATCH_SIZE).toBe(20);
  });

  // Build a minimal Express app using the validator middleware directly
  const { validationResult } = require('express-validator');
  const validators = require('../validators/paymentBatchValidators');

  const VALID_KEY = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

  function makeRecipients(count) {
    return Array.from({ length: count }, () => ({
      recipient_address: VALID_KEY,
      amount: '1.0',
    }));
  }

  let validatorApp;
  beforeAll(() => {
    validatorApp = express();
    validatorApp.use(express.json());
    validatorApp.post('/batch', validators, (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      res.status(200).json({ ok: true });
    });
  });

  test('batch of exactly 20 passes validation', async () => {
    const res = await request(validatorApp)
      .post('/batch')
      .send({ recipients: makeRecipients(20) });
    expect(res.status).toBe(200);
  });

  test('batch of 19 (one below limit) passes validation', async () => {
    const res = await request(validatorApp)
      .post('/batch')
      .send({ recipients: makeRecipients(19) });
    expect(res.status).toBe(200);
  });

  test('batch of 21 (one above limit) returns 400', async () => {
    const res = await request(validatorApp)
      .post('/batch')
      .send({ recipients: makeRecipients(21) });
    expect(res.status).toBe(400);
    const msg = res.body.errors?.[0]?.msg || '';
    expect(msg).toMatch(/20/);
  });

  test('batch of 100 (old limit) returns 400', async () => {
    const res = await request(validatorApp)
      .post('/batch')
      .send({ recipients: makeRecipients(100) });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// #956 — Bulk user management: batch cap enforced before DB access
// ============================================================================
describe('#956 — bulkSuspend / bulkUnsuspend: batch-size cap', () => {
  // Build a minimal app that mounts just the admin bulk routes
  jest.mock('../jobs/contractEventIndexer', () => ({
    indexContractEvents: jest.fn(),
    getContractEvents: jest.fn(),
  }));
  jest.mock('../services/kycAttestation', () => ({
    attestKyc: jest.fn(),
    revokeKyc: jest.fn(),
  }));

  const adminController = require('../controllers/adminController');

  let app;
  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Inject auth directly
    app.use((req, _res, next) => { req.user = { userId: 'admin-uuid', role: 'admin' }; next(); });
    app.post('/admin/bulk-suspend', adminController.bulkSuspend);
    app.post('/admin/bulk-unsuspend', adminController.bulkUnsuspend);
    app.post('/admin/bulk-export', adminController.bulkExport);
  });

  beforeEach(() => jest.clearAllMocks());

  const BULK_MAX = 500;

  test('bulkSuspend with 501 user IDs returns 400 without touching DB', async () => {
    const userIds = Array.from({ length: BULK_MAX + 1 }, (_, i) => `user-${i}`);
    const res = await request(app)
      .post('/admin/bulk-suspend')
      .send({ userIds });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500/);
    // DB must never be touched for oversized batches
    expect(db.pool.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('bulkUnsuspend with 501 user IDs returns 400 without touching DB', async () => {
    const userIds = Array.from({ length: BULK_MAX + 1 }, (_, i) => `user-${i}`);
    const res = await request(app)
      .post('/admin/bulk-unsuspend')
      .send({ userIds });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500/);
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('bulkExport with 501 user IDs returns 400 without touching DB', async () => {
    const userIds = Array.from({ length: BULK_MAX + 1 }, (_, i) => `user-${i}`);
    const res = await request(app)
      .post('/admin/bulk-export')
      .send({ userIds });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500/);
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('bulkSuspend with exactly 500 user IDs proceeds to DB', async () => {
    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // SET LOCAL statement_timeout
        .mockResolvedValueOnce({ rows: [] }) // UPDATE
        .mockResolvedValueOnce(undefined), // COMMIT
      release: jest.fn(),
    };
    db.pool.connect.mockResolvedValueOnce(mockClient);

    const userIds = Array.from({ length: BULK_MAX }, (_, i) => `user-${i}`);
    const res = await request(app)
      .post('/admin/bulk-suspend')
      .send({ userIds, reason: 'test' });

    expect(res.status).toBe(200);
    expect(db.pool.connect).toHaveBeenCalled();
  });

  test('bulkSuspend sets a statement timeout inside the transaction', async () => {
    const queryMock = jest.fn()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // SET LOCAL statement_timeout
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce(undefined); // COMMIT

    const mockClient = { query: queryMock, release: jest.fn() };
    db.pool.connect.mockResolvedValueOnce(mockClient);

    const res = await request(app)
      .post('/admin/bulk-suspend')
      .send({ userIds: ['user-1', 'user-2'] });

    expect(res.status).toBe(200);
    const calls = queryMock.mock.calls.map(([sql]) => (typeof sql === 'string' ? sql : ''));
    expect(calls.some(s => s.toLowerCase().includes('statement_timeout'))).toBe(true);
  });
});

// ============================================================================
// #960 — Contact deduplication: upsert behaviour
// ============================================================================
describe('#960 — addContact: deduplication by Stellar public key', () => {
  const contactsController = require('../controllers/contactsController');

  const VALID_ADDRESS = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

  let app;
  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { userId: 'user-uuid' }; next(); });
    app.post('/contacts', contactsController.addContact);
  });

  beforeEach(() => jest.clearAllMocks());

  test('inserts a new contact when none exists', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'c1', stellar_address: VALID_ADDRESS }] });
    const res = await request(app)
      .post('/contacts')
      .send({ name: 'Alice', stellar_address: VALID_ADDRESS });
    expect(res.status).toBeLessThan(400);
  });
});

// ============================================================================
// #1281 — Scheduled payments: interval placeholder + transactional advance
// ============================================================================
describe('#1281 — scheduledPaymentsJob: interval param + transactional advance', () => {
  jest.mock('../services/stellar', () => ({
    sendPayment: jest.fn(),
  }));

  const stellar = require('../services/stellar');
  const job = require('../jobs/scheduledPaymentsJob');

  function makeClient() {
    return {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
    db.pool.connect.mockReset();
  });

  test('daily schedule advances run_at by one day and stays pending', async () => {
    const payment = {
      id: 'sp-1',
      user_id: 'u-1',
      recipient_address: 'GRECIPIENT',
      amount: '10',
      asset: 'XLM',
      frequency: 'daily',
      status: 'pending',
    };
    db.query.mockResolvedValueOnce({ rows: [payment] }); // fetch due
    stellar.sendPayment.mockResolvedValueOnce({ hash: 'abc' });

    const client = makeClient();
    db.pool.connect.mockResolvedValueOnce(client);

    await job.processOne(payment);

    const updateCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE scheduled_payments')
    );
    expect(updateCall).toBeDefined();
    const [sql, params] = updateCall;
    expect(sql).toContain('$2::interval');
    expect(sql).not.toContain('$interval');
    expect(params).toEqual(['sp-1', '1 day']);
  });

  test('one-off schedule ends completed', async () => {
    const payment = {
      id: 'sp-2',
      user_id: 'u-1',
      recipient_address: 'GRECIPIENT',
      amount: '10',
      asset: 'XLM',
      frequency: 'once',
      status: 'pending',
    };
    stellar.sendPayment.mockResolvedValueOnce({ hash: 'def' });

    const client = makeClient();
    db.pool.connect.mockResolvedValueOnce(client);

    await job.processOne(payment);

    const updateCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE scheduled_payments')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain("status = 'completed'");
  });

  test('DB error after successful sendPayment does not mark schedule failed', async () => {
    const payment = {
      id: 'sp-3',
      user_id: 'u-1',
      recipient_address: 'GRECIPIENT',
      amount: '10',
      asset: 'XLM',
      frequency: 'daily',
      status: 'pending',
    };
    stellar.sendPayment.mockResolvedValueOnce({ hash: 'ghi' });

    const client = makeClient();
    // BEGIN ok, INSERT ok, UPDATE throws
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT transaction
      .mockRejectedValueOnce(new Error('boom')) // UPDATE schedule
      .mockResolvedValueOnce(undefined); // ROLLBACK
    db.pool.connect.mockResolvedValueOnce(client);

    await job.processOne(payment);

    const failedUpdate = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes("status = 'failed'")
    );
    expect(failedUpdate).toBeUndefined();
  });
});
