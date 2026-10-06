/**
 * Tests for issues #954, #956, #957, #960.
 *
 * #954 — Login lockout race: atomic UPDATE...RETURNING replaces read-then-write.
 * #956 — Bulk user management: batch cap enforced + statement timeout added.
 * #957 — Batch payment: MAX_BATCH_SIZE=20 matches on-chain contract limit.
 * #960 — Contact deduplication: same Stellar key upserts instead of duplicating.
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
  jest.mock('../routes/wallet', () => {
    // We test the controller directly via a fresh app
    return null;
  });

  const contactsController = require('../controllers/contactsController');

  const VALID_ADDRESS = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

  let app;
  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { userId: 'user-a' }; next(); });
    app.post('/contacts', contactsController.addContact);
  });

  beforeEach(() => jest.clearAllMocks());

  test('first add returns 201 with message "Contact saved"', async () => {
    // xmax=0 means the row was inserted (not updated)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'c1', name: 'Alice', wallet_address: VALID_ADDRESS,
               notes: null, memo_required: false, default_memo: null, tags: [],
               inserted: true }],
    });

    const res = await request(app)
      .post('/contacts')
      .send({ name: 'Alice', wallet_address: VALID_ADDRESS });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Contact saved');
    // The internal `inserted` flag must not leak to the client
    expect(res.body.contact).not.toHaveProperty('inserted');
  });

  test('duplicate add returns 200 with message "Contact updated" (upsert)', async () => {
    // xmax != 0 means the row was updated
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'c1', name: 'Alice Updated', wallet_address: VALID_ADDRESS,
               notes: null, memo_required: false, default_memo: null, tags: [],
               inserted: false }],
    });

    const res = await request(app)
      .post('/contacts')
      .send({ name: 'Alice Updated', wallet_address: VALID_ADDRESS });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Contact updated');
  });

  test('DB unique-constraint violation (23505) returns 409', async () => {
    const err = new Error('duplicate key value');
    err.code = '23505';
    db.query.mockRejectedValueOnce(err);

    const res = await request(app)
      .post('/contacts')
      .send({ name: 'Alice', wallet_address: VALID_ADDRESS });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('same address for different user succeeds (constraint is per-user)', async () => {
    // Simulate user-b adding the same address — different user_id means no conflict
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'c2', name: 'Bob', wallet_address: VALID_ADDRESS,
               notes: null, memo_required: false, default_memo: null, tags: [],
               inserted: true }],
    });

    // Override auth to user-b
    const appB = express();
    appB.use(express.json());
    appB.use((req, _res, next) => { req.user = { userId: 'user-b' }; next(); });
    appB.post('/contacts', contactsController.addContact);

    const res = await request(appB)
      .post('/contacts')
      .send({ name: 'Bob', wallet_address: VALID_ADDRESS });

    expect(res.status).toBe(201);
  });
});

// ============================================================================
// #954 — Login lockout: atomic counter (unit-level, no HTTP app needed)
// ============================================================================
describe('#954 — login lockout: atomic UPDATE used for failed attempt counter', () => {
  // We verify the SQL issued by the controller uses a single atomic UPDATE
  // rather than a read-then-write approach.

  jest.mock('../utils/tokens', () => ({
    COOKIE_NAME: 'rt',
    COOKIE_OPTIONS: {},
    signAccessToken: jest.fn(() => 'mock-token'),
    generateRefreshToken: jest.fn(() => ({ raw: 'raw', hash: 'hash' })),
    refreshTokenExpiresAt: jest.fn(() => new Date(Date.now() + 86400000)),
    signDeviceToken: jest.fn(),
    verifyDeviceToken: jest.fn(),
  }));
  jest.mock('../middleware/csrf', () => ({ setCsrfCookie: jest.fn() }));
  jest.mock('../services/email', () => ({
    sendVerificationEmail: jest.fn(),
    sendPasswordResetEmail: jest.fn(),
    sendBackupCodeWarningEmail: jest.fn(),
    sendEmailChangeRequestedNotice: jest.fn(),
  }));
  jest.mock('../services/sms', () => ({ sendOTP: jest.fn() }));
  jest.mock('../services/pin', () => ({
    hashPIN: jest.fn(),
    comparePIN: jest.fn(),
    validatePIN: jest.fn(() => true),
  }));
  jest.mock('../services/twofa', () => ({
    generateSecret: jest.fn(),
    verifyToken: jest.fn(),
    generateBackupCodes: jest.fn(() => []),
    useBackupCode: jest.fn(),
    hashBackupCode: jest.fn(),
    verifyBackupCode: jest.fn(),
  }));
  jest.mock('./sessionController', () => ({ recordSession: jest.fn(), invalidateOtherSessions: jest.fn() }), { virtual: true });
  jest.mock('../controllers/sessionController', () => ({
    recordSession: jest.fn().mockResolvedValue(undefined),
    invalidateOtherSessions: jest.fn(),
  }));

  let authController;
  let authApp;

  beforeAll(() => {
    authController = require('../controllers/authController');
    authApp = express();
    authApp.use(express.json());
    authApp.post('/login', authController.login);
  });

  beforeEach(() => jest.clearAllMocks());

  test('failed login issues a single atomic UPDATE (not a read then separate write)', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('correct-password', 1);

    // Simulate user found, not locked
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        full_name: 'Test',
        email: 'test@example.com',
        password_hash: hash,
        email_verified: true,
        role: 'user',
        totp_enabled: false,
        totp_secret: null,
        failed_login_attempts: 2,
        locked_until: null,
        last_failed_attempt_at: new Date().toISOString(),
        public_key: 'GPUBKEY',
      }],
    });

    // Simulate the atomic UPDATE RETURNING result (3 failed attempts, not locked yet)
    db.query.mockResolvedValueOnce({
      rows: [{ failed_login_attempts: 3, locked_until: null }],
    });

    const res = await request(authApp)
      .post('/login')
      .send({ email: 'test@example.com', password: 'wrong-password' });

    expect(res.status).toBe(401);

    // The second DB call (after the initial SELECT) must be an UPDATE that
    // atomically increments the counter using SQL arithmetic (failed_login_attempts + 1)
    const calls = db.query.mock.calls;
    // There should be exactly 2 DB calls: 1 SELECT + 1 atomic UPDATE
    expect(calls.length).toBe(2);

    const updateCall = calls[1][0]; // SQL string of the second call
    expect(typeof updateCall).toBe('string');
    // Must use SQL-level increment (not a JS-computed value)
    expect(updateCall).toMatch(/failed_login_attempts\s*\+\s*1/i);
    // Must use RETURNING to get the new value atomically
    expect(updateCall.toUpperCase()).toContain('RETURNING');
  });

  test('lockout is applied when atomic update returns attempts >= 5', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('correct-password', 1);

    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        full_name: 'Test',
        email: 'test@example.com',
        password_hash: hash,
        email_verified: true,
        role: 'user',
        totp_enabled: false,
        totp_secret: null,
        failed_login_attempts: 4,
        locked_until: null,
        last_failed_attempt_at: new Date().toISOString(),
        public_key: 'GPUBKEY',
      }],
    });

    // Atomic UPDATE returns locked_until set in the future (5th attempt)
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    db.query.mockResolvedValueOnce({
      rows: [{ failed_login_attempts: 5, locked_until: lockedUntil.toISOString() }],
    });

    const res = await request(authApp)
      .post('/login')
      .send({ email: 'test@example.com', password: 'wrong-password' });

    expect(res.status).toBe(423);
    expect(res.body).toHaveProperty('locked_until');
    // Audit log must be called with account_locked action and the right metadata
    expect(audit.log).toHaveBeenCalled();
    const [calledUserId, calledAction, , , calledMeta] = audit.log.mock.calls[0];
    expect(calledUserId).toBe('user-1');
    expect(calledAction).toBe('account_locked');
    expect(calledMeta).toMatchObject({ reason: 'excessive_failed_login_attempts', attempts: 5 });
  });
});
