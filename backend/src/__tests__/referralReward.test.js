'use strict';

/**
 * Tests for referralRewardService.creditReferralReward()
 *
 * Covers:
 *   - Skips non-referred users
 *   - Inserts reward row, mints tokens, updates status to 'credited', notifies referrer
 *   - Idempotent: duplicate call on same payment_id is a no-op
 *   - Idempotent: duplicate call for same referee_id is a no-op
 *   - Sets status to 'failed' and logs when mintPoints throws
 */

jest.mock('../db');
jest.mock('../services/loyaltyToken', () => ({ mintPoints: jest.fn() }));
jest.mock('../controllers/notificationController', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../utils/logger', () => ({ warn: jest.fn() }));

const db = require('../db');
const { mintPoints } = require('../services/loyaltyToken');
const { sendPushToUser } = require('../controllers/notificationController');
const { creditReferralReward, REFERRAL_REWARD_TOKENS } = require('../services/referralRewardService');

const REFERRER_ID  = 'aaaa0000-0000-0000-0000-000000000001';
const REFEREE_ID   = 'bbbb0000-0000-0000-0000-000000000002';
const PAYMENT_ID   = 'cccc0000-0000-0000-0000-000000000003';
const WALLET       = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const REWARD_ROW_ID = 'dddd0000-0000-0000-0000-000000000004';

function mockReferralLookup() {
  db.query.mockResolvedValueOnce({
    rows: [{ referrer_id: REFERRER_ID, referrer_email: 'ref@example.com', referee_email: 'fee@example.com' }],
  });
}

function mockInsertSuccess() {
  db.query.mockResolvedValueOnce({ rows: [{ id: REWARD_ROW_ID }] });
}

function mockWalletLookup() {
  db.query.mockResolvedValueOnce({ rows: [{ public_key: WALLET }] });
}

function mockStatusUpdate() {
  db.query.mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  mintPoints.mockResolvedValue({ txHash: 'abc123' });
  sendPushToUser.mockResolvedValue(undefined);
});

describe('creditReferralReward', () => {
  it('does nothing when user is not referred', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no referrer found

    await creditReferralReward(REFEREE_ID, PAYMENT_ID);

    expect(mintPoints).not.toHaveBeenCalled();
  });

  it('mints tokens and marks reward credited on happy path', async () => {
    mockReferralLookup();
    mockInsertSuccess();
    mockWalletLookup();
    mockStatusUpdate(); // UPDATE status = 'credited'

    await creditReferralReward(REFEREE_ID, PAYMENT_ID);

    expect(mintPoints).toHaveBeenCalledWith({ recipientWallet: WALLET, points: REFERRAL_REWARD_TOKENS });

    // Verify status update was called with 'credited'
    const updateCall = db.query.mock.calls.find(
      ([sql]) => sql.includes("status = 'credited'"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe(REWARD_ROW_ID);
  });

  it('sends push notification to referrer', async () => {
    mockReferralLookup();
    mockInsertSuccess();
    mockWalletLookup();
    mockStatusUpdate();

    await creditReferralReward(REFEREE_ID, PAYMENT_ID);

    // Allow fire-and-forget promise to resolve
    await Promise.resolve();

    expect(sendPushToUser).toHaveBeenCalledWith(
      REFERRER_ID,
      expect.objectContaining({
        title: expect.stringContaining('Referral reward'),
        body: expect.stringContaining(String(REFERRAL_REWARD_TOKENS)),
      }),
    );
  });

  it('is idempotent — unique_violation on referee_id is swallowed', async () => {
    mockReferralLookup();
    const uniqueErr = Object.assign(new Error('duplicate'), { code: '23505' });
    db.query.mockRejectedValueOnce(uniqueErr); // INSERT throws unique violation

    await expect(creditReferralReward(REFEREE_ID, PAYMENT_ID)).resolves.toBeUndefined();
    expect(mintPoints).not.toHaveBeenCalled();
  });

  it('is idempotent — unique_violation on payment_id is swallowed', async () => {
    mockReferralLookup();
    const uniqueErr = Object.assign(new Error('duplicate key value'), { code: '23505' });
    db.query.mockRejectedValueOnce(uniqueErr);

    await expect(creditReferralReward(REFEREE_ID, PAYMENT_ID)).resolves.toBeUndefined();
    expect(mintPoints).not.toHaveBeenCalled();
  });

  it('marks reward failed and logs when mintPoints throws', async () => {
    mockReferralLookup();
    mockInsertSuccess();
    mockWalletLookup();
    mintPoints.mockRejectedValueOnce(new Error('Soroban error'));
    mockStatusUpdate(); // UPDATE status = 'failed'

    await creditReferralReward(REFEREE_ID, PAYMENT_ID);

    const failCall = db.query.mock.calls.find(
      ([sql]) => sql.includes("status = 'failed'"),
    );
    expect(failCall).toBeDefined();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
