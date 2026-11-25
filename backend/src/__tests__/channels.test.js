/**
 * Tests for #866: routes/channels.js must use req.user.userId (not req.user.id)
 *
 * The JWT payload is { userId, email, role } — so req.user.userId is the
 * authenticated user's id after jwt.verify().  Every handler in channels.js
 * was reading req.user.id (always undefined), which caused:
 *   - /open  and /close to always return 400 "Wallet not found"
 *   - /transact to pass userId: undefined into the paymentChannel service
 *   - GET /  to always return [] for every authenticated user
 *
 * Acceptance criteria covered:
 *  ✓ All six occurrences of req.user.id changed to req.user.userId
 *  ✓ /open  succeeds as authenticated user (not 400 "Wallet not found")
 *  ✓ GET /  returns the channel after opening it (not always [])
 *  ✓ /transact updates channel balances for the correct owning user
 *  ✓ Regression: req.user.userId is used — req.user.id is absent from the file
 */

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any require() calls
// ---------------------------------------------------------------------------
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () =>
  jest.fn((req, _res, next) => {
    // Simulate what auth.js does: req.user = jwt.verify(token, secret)
    // The JWT payload shape is { userId, email, role }
    req.user = { userId: req.headers['x-test-user-id'] || 'user-abc-123' };
    next();
  })
);
jest.mock('../services/paymentChannel', () => ({
  openChannel: jest.fn(),
  transact: jest.fn(),
  closeChannel: jest.fn(),
}));
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
const request = require('supertest');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { openChannel, transact, closeChannel } = require('../services/paymentChannel');
const channelsRouter = require('../routes/channels');

// ---------------------------------------------------------------------------
// App fixture
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use('/api/channels', channelsRouter);
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message });
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const USER_ID = 'user-abc-123';
const CHANNEL_ID = uuidv4();
const SENDER_KEY = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const RECIPIENT_KEY = 'GCUB4U3E5AXUY2OJOFKQGDL2ZIEAFHAXNERCZ4EEKF2J6IFIK7KYYPUI';
const ENCRYPTED_SECRET = 'deadbeef:deadbeef01234567deadbeef01234567deadbeef01234567';

const WALLET_ROW = {
  public_key: SENDER_KEY,
  encrypted_secret_key: ENCRYPTED_SECRET,
};

const CHANNEL_ROW = {
  id: CHANNEL_ID,
  user_id: USER_ID,
  sender_public_key: SENDER_KEY,
  recipient_public_key: RECIPIENT_KEY,
  asset: 'XLM',
  funding_amount: '10',
  sender_balance: '10',
  recipient_balance: '0',
  status: 'open',
  created_at: new Date().toISOString(),
};

beforeEach(() => {
  jest.resetAllMocks();
});

// ===========================================================================
// #866 — Regression: source file must not reference req.user.id
// ===========================================================================
describe('#866 regression — req.user.id must be absent from channels.js', () => {
  test('channels.js source does not contain req.user.id', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../routes/channels.js'),
      'utf8'
    );
    // req.user.id would match this pattern; req.user.userId must be used instead
    expect(src).not.toMatch(/req\.user\.id(?!entity|\.)/);
  });

  test('channels.js source uses req.user.userId in all handler positions', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../routes/channels.js'),
      'utf8'
    );
    const matches = src.match(/req\.user\.userId/g) || [];
    // Six positions: /open ×2, /transact ×1, /close ×2, GET / ×1
    expect(matches.length).toBe(6);
  });
});

// ===========================================================================
// #866 — POST /open: must NOT return 400 "Wallet not found" for valid user
// ===========================================================================
describe('POST /api/channels/open', () => {
  test('returns 201 and the new channel when wallet is found', async () => {
    db.query.mockResolvedValueOnce({ rows: [WALLET_ROW] }); // wallet lookup
    openChannel.mockResolvedValueOnce(CHANNEL_ROW);

    const res = await request(app)
      .post('/api/channels/open')
      .set('x-test-user-id', USER_ID)
      .send({
        recipientPublicKey: RECIPIENT_KEY,
        fundingAmount: 10,
        asset: 'XLM',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CHANNEL_ID);
    // The db wallet query must have been called with the userId from the JWT
    expect(db.query.mock.calls[0][1]).toEqual([USER_ID]);
  });

  test('passes userId from req.user.userId (not undefined) into openChannel', async () => {
    db.query.mockResolvedValueOnce({ rows: [WALLET_ROW] });
    openChannel.mockResolvedValueOnce(CHANNEL_ROW);

    await request(app)
      .post('/api/channels/open')
      .set('x-test-user-id', USER_ID)
      .send({ recipientPublicKey: RECIPIENT_KEY, fundingAmount: 10 });

    const { userId } = openChannel.mock.calls[0][0];
    expect(userId).toBe(USER_ID);
    expect(userId).not.toBeUndefined();
  });

  test('returns 400 when wallet is not found (but for the right user)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no wallet for this user

    const res = await request(app)
      .post('/api/channels/open')
      .set('x-test-user-id', USER_ID)
      .send({ recipientPublicKey: RECIPIENT_KEY, fundingAmount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Wallet not found');
  });
});

// ===========================================================================
// #866 — GET /: must return channels for the authenticated user (not always [])
// ===========================================================================
describe('GET /api/channels', () => {
  test('returns the authenticated user\'s channels', async () => {
    db.query.mockResolvedValueOnce({ rows: [CHANNEL_ROW] });

    const res = await request(app)
      .get('/api/channels')
      .set('x-test-user-id', USER_ID);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(CHANNEL_ID);
  });

  test('queries by the correct userId (not undefined)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/channels')
      .set('x-test-user-id', USER_ID);

    expect(db.query.mock.calls[0][1]).toEqual([USER_ID]);
  });

  test('returns empty array when user has no channels', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/channels')
      .set('x-test-user-id', USER_ID);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ===========================================================================
// #866 — POST /transact: must update balances for the correct owning user
// ===========================================================================
describe('POST /api/channels/transact', () => {
  test('updates channel balances for the authenticated user', async () => {
    const updatedChannel = {
      ...CHANNEL_ROW,
      sender_balance: '7',
      recipient_balance: '3',
    };
    transact.mockResolvedValueOnce(updatedChannel);

    const res = await request(app)
      .post('/api/channels/transact')
      .set('x-test-user-id', USER_ID)
      .send({ channelId: CHANNEL_ID, amount: 3 });

    expect(res.status).toBe(200);
    expect(res.body.sender_balance).toBe('7');
    expect(res.body.recipient_balance).toBe('3');
  });

  test('passes the correct userId (not undefined) to transact service', async () => {
    transact.mockResolvedValueOnce(CHANNEL_ROW);

    await request(app)
      .post('/api/channels/transact')
      .set('x-test-user-id', USER_ID)
      .send({ channelId: CHANNEL_ID, amount: 1 });

    const { userId } = transact.mock.calls[0][0];
    expect(userId).toBe(USER_ID);
    expect(userId).not.toBeUndefined();
  });
});

// ===========================================================================
// #866 — POST /close: must not return 400 "Wallet not found" for valid user
// ===========================================================================
describe('POST /api/channels/close', () => {
  test('returns the closed channel when wallet is found', async () => {
    const closedChannel = { ...CHANNEL_ROW, status: 'closed' };
    db.query.mockResolvedValueOnce({ rows: [{ encrypted_secret_key: ENCRYPTED_SECRET }] });
    closeChannel.mockResolvedValueOnce(closedChannel);

    const res = await request(app)
      .post('/api/channels/close')
      .set('x-test-user-id', USER_ID)
      .send({ channelId: CHANNEL_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(db.query.mock.calls[0][1]).toEqual([USER_ID]);
  });

  test('passes correct userId into closeChannel', async () => {
    const closedChannel = { ...CHANNEL_ROW, status: 'closed' };
    db.query.mockResolvedValueOnce({ rows: [{ encrypted_secret_key: ENCRYPTED_SECRET }] });
    closeChannel.mockResolvedValueOnce(closedChannel);

    await request(app)
      .post('/api/channels/close')
      .set('x-test-user-id', USER_ID)
      .send({ channelId: CHANNEL_ID });

    const { userId } = closeChannel.mock.calls[0][0];
    expect(userId).toBe(USER_ID);
    expect(userId).not.toBeUndefined();
  });
});
