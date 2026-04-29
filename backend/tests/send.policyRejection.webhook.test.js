/**
 * Tests for issue #255:
 * POST /api/payments/send must emit payment.failed webhook for all
 * application-level policy rejections with a matching code field.
 */
jest.mock('../src/db');
jest.mock('../src/services/stellar');
jest.mock('../src/services/webhook', () => ({ deliver: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/cache', () => ({ del: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/fraudDetection', () => ({
  checkVelocity: jest.fn().mockResolvedValue(false),
  checkDailyLimit: jest.fn().mockResolvedValue(false),
  checkFraud: jest.fn().mockResolvedValue({ blocked: false }),
  logFraudBlock: jest.fn(),
}));
jest.mock('../src/services/memoRequired', () => ({ isMemoRequired: jest.fn().mockResolvedValue(false) }));
jest.mock('../src/controllers/referralController', () => ({ awardReferralCredit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/loyaltyToken', () => ({ mintPoints: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/feeDistributor', () => ({ depositFee: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/db');
const webhook = require('../src/services/webhook');
const { checkFraud, checkVelocity } = require('../src/services/fraudDetection');
const { send } = require('../src/controllers/paymentController');

const SENDER = 'GABC1234SENDERKEY000000000000000000000000000000000000000';
const RECIPIENT = 'GDIFFERENTRECIPIENTKEY0000000000000000000000000000000000';

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq(overrides = {}) {
  return {
    user: { userId: 1 },
    body: { recipient_address: RECIPIENT, amount: '10', asset: 'XLM', ...overrides },
    logger: { warn: jest.fn(), info: jest.fn() },
    requestId: 'test-req-id',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('#255 payment.failed webhook for policy rejections', () => {
  test('emits payment.failed with code KYC_REQUIRED when KYC is not verified for large transaction', async () => {
    // amount=200 USDC → estimatedUSD=200 ≥ KYC_THRESHOLD_USD (100) — ensureKycIfNeeded throws
    db.query.mockResolvedValueOnce({ rows: [{ kyc_status: 'unverified' }] });

    const req = makeReq({ amount: '200', asset: 'USDC' });
    const res = mockRes();
    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(webhook.deliver).toHaveBeenCalledWith(
      'payment.failed',
      expect.objectContaining({ code: 'KYC_REQUIRED' }),
    );
  });

  test('emits payment.failed with code DAILY_LIMIT_EXCEEDED when daily sum exceeds limit', async () => {
    // Low-value XLM: no KYC/phone checks. Wallet lookup then dailyLimitExceeded.
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ total: '50000' }] }); // 50000 + 10 > DAILY_SEND_LIMIT

    const req = makeReq({ amount: '10', asset: 'XLM' });
    const res = mockRes();
    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(webhook.deliver).toHaveBeenCalledWith(
      'payment.failed',
      expect.objectContaining({ code: 'DAILY_LIMIT_EXCEEDED' }),
    );
  });

  test('emits payment.failed with code FRAUD_BLOCKED when velocity check flags the sender', async () => {
    checkVelocity.mockResolvedValueOnce(true);

    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    const req = makeReq({ amount: '10', asset: 'XLM' });
    const res = mockRes();
    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(429);
    expect(webhook.deliver).toHaveBeenCalledWith(
      'payment.failed',
      expect.objectContaining({ code: 'FRAUD_BLOCKED' }),
    );
  });

  test('emits payment.failed with code FRAUD_BLOCKED when fraud check blocks the transaction', async () => {
    checkFraud.mockResolvedValueOnce({ blocked: true, reason: 'Suspicious activity detected' });

    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    const req = makeReq({ amount: '10', asset: 'XLM' });
    const res = mockRes();
    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(429);
    expect(webhook.deliver).toHaveBeenCalledWith(
      'payment.failed',
      expect.objectContaining({ code: 'FRAUD_BLOCKED' }),
    );
  });
});
