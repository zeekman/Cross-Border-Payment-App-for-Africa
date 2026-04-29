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

  test('returns 400 INSUFFICIENT_BALANCE when available < required', async () => {
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
      .mockResolvedValueOnce({ rows: [{ total: '0' }] }); // daily limit

    cache.get = jest.fn().mockResolvedValue(null);
    cache.set = jest.fn().mockResolvedValue(undefined);
    getBalance.mockResolvedValue([{ asset: 'XLM', balance: '0.5', available_balance: '0.5' }]);

    const { send } = require('../controllers/paymentController');

    const req = {
      user: { userId: 'user-1' },
      body: { recipient_address: 'GRECIPIENT123456789012345678901234567890123456789012345', amount: '100', asset: 'XLM' },
      requestId: 'req-1',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await send(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Insufficient balance',
        code: 'INSUFFICIENT_BALANCE',
      })
    );
  });
});
