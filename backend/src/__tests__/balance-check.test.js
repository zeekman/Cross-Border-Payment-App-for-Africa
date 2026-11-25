const { getBalance } = require('../services/stellar');
const cache = require('../utils/cache');

jest.mock('../services/stellar');
jest.mock('../utils/cache');

// Extract the helper by loading the module and inspecting internals via a
// thin integration: call the exported `send` handler with a mocked request.
// We test the balance-check logic in isolation by mocking getBalance.

describe('checkSufficientBalance (via send handler)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function buildMocks({ available = '0', asset = 'XLM' } = {}) {
    const db = require('../db');
    db.query = jest.fn().mockResolvedValue({ rows: [{ kyc_status: 'verified', phone_verified: true }] });

    cache.get = jest.fn().mockResolvedValue(null);
    cache.set = jest.fn().mockResolvedValue(undefined);
    cache.del = jest.fn().mockResolvedValue(undefined);

    getBalance.mockResolvedValue([{ asset, balance: available, available_balance: available }]);
  }

  function setupController({ available = '0.5', dailyTotal = '0' } = {}) {
    jest.mock('../db');
    jest.mock('../services/fraudDetection', () => ({ checkFraud: jest.fn().mockResolvedValue({ blocked: false }), logFraudBlock: jest.fn() }));
    jest.mock('../services/memoRequired', () => ({ isMemoRequired: jest.fn().mockResolvedValue(false) }));
    jest.mock('../services/webhook', () => ({ deliver: jest.fn() }));
    jest.mock('../services/loyaltyToken', () => ({ mintPoints: jest.fn() }));
    jest.mock('../services/feeDistributor', () => ({ depositFee: jest.fn() }));
    jest.mock('../controllers/referralController', () => ({ awardReferralCredit: jest.fn() }));

    const db = require('../db');
    // wallet lookup
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified', phone_verified: true }] }) // phone/kyc check
      .mockResolvedValueOnce({ rows: [{ public_key: 'GSENDER', encrypted_secret_key: 'enc' }] }) // wallet
      .mockResolvedValueOnce({ rows: [{ total: dailyTotal }] }); // daily limit

    cache.get = jest.fn().mockResolvedValue(null);
    cache.set = jest.fn().mockResolvedValue(undefined);
    getBalance.mockResolvedValue([{ asset: 'XLM', balance: available, available_balance: available }]);

    const webhook = require('../services/webhook');
    const { send } = require('../controllers/paymentController');

    return { send, webhook };
  }

  function buildReq(overrides = {}) {
    return {
      user: { userId: 'user-1' },
      body: { recipient_address: 'GRECIPIENT123456789012345678901234567890123456789012345', amount: '100', asset: 'XLM' },
      requestId: 'req-1',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ...overrides,
    };
  }

  function buildRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  test('returns 400 INSUFFICIENT_BALANCE when available < required', async () => {
    const { send, webhook } = setupController({ available: '0.5' });

    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await send(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Insufficient balance',
        code: 'INSUFFICIENT_BALANCE',
        available: '0.5',
        required: '100',
      })
    );
    expect(webhook.deliver).toHaveBeenCalledWith(
      'payment.failed',
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' })
    );
  });

  test('returns 400 DAILY_LIMIT_EXCEEDED when daily total exceeds limit', async () => {
    const { send, webhook } = setupController({ available: '1000', dailyTotal: '999999999' });

    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await send(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(String),
        code: 'DAILY_LIMIT_EXCEEDED',
      })
    );
    expect(webhook.deliver).toHaveBeenCalledWith(
      'payment.failed',
      expect.objectContaining({ code: 'DAILY_LIMIT_EXCEEDED' })
    );
  });

  test('500 responses return a generic message with request id and never leak internals', async () => {
    const { send } = setupController({ available: '1000' });

    // Force an internal failure after validation by making the wallet lookup throw.
    const db = require('../db');
    db.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified', phone_verified: true }] })
      .mockRejectedValueOnce(new Error('secret internal db detail'));

    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await send(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual(
      expect.objectContaining({ error: expect.any(String), requestId: 'req-1' })
    );
    expect(JSON.stringify(body)).not.toContain('secret internal db detail');
  });
});
