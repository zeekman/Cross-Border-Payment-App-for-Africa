'use strict';

/**
 * Tests for referralController.getReferralDetails()
 *
 * Covers:
 *   - Returns list of referrals with pending, credited, and ineligible statuses
 *   - Includes referral info (email, referred_at) and reward status
 *   - Handles users with no referrals
 *   - Calculates pending_rewards and credited_rewards counts
 */

jest.mock('../db');
const db = require('../db');
const { getReferralDetails } = require('../controllers/referralController');

const USER_ID = 'aaaa0000-0000-0000-0000-000000000001';
const REF1_ID = 'bbbb0000-0000-0000-0000-000000000002';
const REF2_ID = 'cccc0000-0000-0000-0000-000000000003';
const REF3_ID = 'dddd0000-0000-0000-0000-000000000004';

describe('getReferralDetails', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      user: { userId: USER_ID },
    };
    res = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it('returns list of referrals with pending and credited rewards', async () => {
    // Mock referral lookup
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: REF1_ID,
          email: 'ref1@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
        {
          id: REF2_ID,
          email: 'ref2@example.com',
          created_at: '2024-01-05T00:00:00Z',
        },
        {
          id: REF3_ID,
          email: 'ref3@example.com',
          created_at: '2024-01-10T00:00:00Z',
        },
      ],
    });

    // Mock reward lookups for each referral
    db.query.mockResolvedValueOnce({
      rows: [{ status: 'pending', reward_amount: 50, created_at: '2024-01-01T12:00:00Z' }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ status: 'credited', reward_amount: 50, created_at: '2024-01-05T12:00:00Z' }],
    });
    db.query.mockResolvedValueOnce({
      rows: [], // ineligible — no reward row
    });

    await getReferralDetails(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        referrals: expect.arrayContaining([
          expect.objectContaining({
            referral_id: REF1_ID,
            email: 'ref1@example.com',
            reward_status: 'pending',
            reward_amount: 50,
          }),
          expect.objectContaining({
            referral_id: REF2_ID,
            email: 'ref2@example.com',
            reward_status: 'credited',
            reward_amount: 50,
          }),
          expect.objectContaining({
            referral_id: REF3_ID,
            email: 'ref3@example.com',
            reward_status: 'ineligible',
            reward_amount: null,
          }),
        ]),
        total_referrals: 3,
        pending_rewards: 1,
        credited_rewards: 1,
      })
    );
  });

  it('handles user with no referrals', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await getReferralDetails(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        referrals: [],
        total_referrals: 0,
        pending_rewards: 0,
        credited_rewards: 0,
      })
    );
  });

  it('handles failed rewards', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: REF1_ID,
          email: 'ref1@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
    });

    db.query.mockResolvedValueOnce({
      rows: [{ status: 'failed', reward_amount: 50, created_at: '2024-01-01T12:00:00Z' }],
    });

    await getReferralDetails(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        referrals: expect.arrayContaining([
          expect.objectContaining({
            referral_id: REF1_ID,
            reward_status: 'failed',
            reward_amount: 50,
          }),
        ]),
        pending_rewards: 0,
        credited_rewards: 0,
      })
    );
  });

  it('calls next with error on database failure', async () => {
    const error = new Error('DB connection failed');
    db.query.mockRejectedValueOnce(error);

    await getReferralDetails(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
