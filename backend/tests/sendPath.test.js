/**
 * Tests for issue #240:
 * sendPath / sendStrictReceivePath catch blocks must NOT insert a failed
 * transaction record when public_key is still undefined (i.e. the error
 * occurred before wallet resolution).
 */
jest.mock('../src/db');
jest.mock('../src/services/stellar');
jest.mock('../src/services/fraudDetection', () => ({
  checkFraud: jest.fn().mockResolvedValue({ blocked: false }),
  logFraudBlock: jest.fn(),
}));

const db = require('../src/db');
const { sendPath, sendStrictReceivePath } = require('../src/controllers/paymentController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function baseReq(body = {}) {
  return {
    user: { userId: 1 },
    requestId: 'req-test',
    logger: { info: jest.fn(), error: jest.fn() },
    body: {
      recipient_address: 'GDEST000000000000000000000000000000000000000000000000000',
      source_asset: 'XLM',
      source_amount: '10',
      destination_asset: 'USDC',
      destination_min_amount: '9',
      path: [],
      ...body,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sendPath — #240', () => {
  test('skips DB insert when error occurs before wallet resolution', async () => {
    // Simulate a DB error on the very first query (KYC / wallet lookup)
    db.query.mockRejectedValueOnce(new Error('DB connection lost'));

    const req = baseReq();
    const res = mockRes();
    const next = jest.fn();

    await sendPath(req, res, next);

    // next() should have been called with the error
    expect(next).toHaveBeenCalledWith(expect.any(Error));

    // db.query should have been called once (the failing query) — no INSERT
    const insertCalls = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes("'failed'"),
    );
    expect(insertCalls).toHaveLength(0);
  });

  test('inserts failed record when error occurs after wallet resolution', async () => {
    const { sendPathPayment } = require('../src/services/stellar');

    // wallet lookup succeeds
    db.query
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified', phone_verified: true }] }) // KYC/phone check
      .mockResolvedValueOnce({ rows: [{ public_key: 'GSENDER00000000000000000000000000000000000000000000000000', encrypted_secret_key: 'enc' }] }) // wallet
      .mockResolvedValue({ rows: [] }); // INSERT and any other calls

    // Stellar call fails after wallet is resolved
    sendPathPayment.mockRejectedValueOnce(Object.assign(new Error('Stellar error'), { status: 400 }));

    const req = baseReq();
    const res = mockRes();
    const next = jest.fn();

    await sendPath(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);

    const insertCalls = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes("'failed'"),
    );
    expect(insertCalls).toHaveLength(1);
    // sender_wallet must be the resolved public key, not empty
    expect(insertCalls[0][1][1]).toBe('GSENDER00000000000000000000000000000000000000000000000000');
  });
});

describe('sendStrictReceivePath — #240', () => {
  test('skips DB insert when error occurs before wallet resolution', async () => {
    db.query.mockRejectedValueOnce(new Error('DB connection lost'));

    const req = {
      user: { userId: 1 },
      requestId: 'req-test',
      body: {
        recipient_address: 'GDEST000000000000000000000000000000000000000000000000000',
        source_asset: 'XLM',
        source_max_amount: '10',
        destination_asset: 'USDC',
        destination_amount: '9',
        path: [],
      },
    };
    const res = mockRes();
    const next = jest.fn();

    await sendStrictReceivePath(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));

    const insertCalls = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes("'failed'"),
    );
    expect(insertCalls).toHaveLength(0);
  });
});
