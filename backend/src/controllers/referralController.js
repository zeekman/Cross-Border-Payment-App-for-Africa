const db = require('../db');
const { detectReferralAbuse } = require('../services/referralAbuseGuard');
const logger = require('../utils/logger');

const REFERRAL_CREDIT_BPS = parseInt(process.env.REFERRAL_CREDIT_BPS || '50', 10); // 0.5% fee discount
const REFERRAL_EXPIRY_DAYS = 90;

async function getStats(req, res, next) {
  try {
    const userId = req.user.userId;

    const userResult = await db.query(
      'SELECT referral_code FROM users WHERE id = $1',
      [userId]
    );
    const { referral_code } = userResult.rows[0] || {};

    const referralsResult = await db.query(
      `SELECT COUNT(*) AS referral_count FROM users WHERE referred_by = $1`,
      [referral_code || '']
    );

    const creditsResult = await db.query(
      `SELECT COALESCE(SUM(amount_bps), 0) AS total_bps,
              COUNT(*) FILTER (WHERE NOT used AND expires_at > NOW()) AS active_credits
       FROM referral_credits WHERE user_id = $1`,
      [userId]
    );

    const rewardsResult = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'credited') AS first_payments_completed,
              COALESCE(SUM(reward_amount) FILTER (WHERE status = 'credited'), 0) AS total_rewards_earned
       FROM referral_rewards WHERE referrer_id = $1`,
      [userId]
    );

    res.json({
      referral_code,
      referral_count: parseInt(referralsResult.rows[0].referral_count, 10),
      total_credits_bps: parseInt(creditsResult.rows[0].total_bps, 10),
      active_credits: parseInt(creditsResult.rows[0].active_credits, 10),
      credit_per_referral_bps: REFERRAL_CREDIT_BPS,
      first_payments_completed: parseInt(rewardsResult.rows[0].first_payments_completed, 10),
      total_rewards_earned: parseInt(rewardsResult.rows[0].total_rewards_earned, 10),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get list of referrals with their reward status (pending, credited, failed, ineligible)
 */
async function getReferralDetails(req, res, next) {
  try {
    const userId = req.user.userId;

    // Get all referred users
    const referralsResult = await db.query(
      `SELECT u.id, u.email, u.created_at
       FROM users u
       JOIN users referrer ON referrer.id = $1
       WHERE u.referred_by = referrer.referral_code
       ORDER BY u.created_at DESC`,
      [userId]
    );

    const referrals = referralsResult.rows || [];

    // For each referred user, get their reward status
    const details = await Promise.all(
      referrals.map(async (ref) => {
        const rewardResult = await db.query(
          `SELECT status, reward_amount, created_at
           FROM referral_rewards
           WHERE referee_id = $1`,
          [ref.id]
        );

        const reward = rewardResult.rows[0];
        const status = reward ? reward.status : 'ineligible';

        return {
          referral_id: ref.id,
          email: ref.email,
          referred_at: ref.created_at,
          reward_status: status,
          reward_amount: reward ? reward.reward_amount : null,
          reward_claimed_at: reward ? reward.created_at : null,
        };
      })
    );

    res.json({
      referrals: details,
      total_referrals: details.length,
      pending_rewards: details.filter(r => r.reward_status === 'pending').length,
      credited_rewards: details.filter(r => r.reward_status === 'credited').length,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Called after a referred user's first transaction completes.
 * Awards fee-discount credit to the referrer.
 */
async function awardReferralCredit(referredUserId) {
  const result = await db.query(
    `SELECT u.id AS referrer_id
     FROM users referred
     JOIN users u ON u.referral_code = referred.referred_by
     WHERE referred.id = $1`,
    [referredUserId]
  );
  if (!result.rows[0]) return;

  const referrerId = result.rows[0].referrer_id;

  // Reject self-referral and circular referral chains before crediting
  const abuseReason = await detectReferralAbuse(referrerId, referredUserId);
  if (abuseReason) {
    logger.warn('Referral credit withheld — abuse check failed', {
      referrerId, referredUserId, reason: abuseReason,
    });
    return;
  }

  // Only award once per referred user
  const existing = await db.query(
    'SELECT id FROM referral_credits WHERE referred_user_id = $1',
    [referredUserId]
  );
  if (existing.rows.length > 0) return;

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFERRAL_EXPIRY_DAYS);

  await db.query(
    `INSERT INTO referral_credits (user_id, referred_user_id, amount_bps, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [referrerId, referredUserId, REFERRAL_CREDIT_BPS, expiresAt]
  );
}

/**
 * POST /api/referrals/award
 * Admin/internal endpoint — awards referral credit for a given referred user.
 * Body: { referred_user_id: string }
 */
async function awardReferralCreditHandler(req, res, next) {
  try {
    const { referred_user_id } = req.body;
    if (!referred_user_id) {
      return res.status(400).json({ error: 'referred_user_id is required' });
    }
    await awardReferralCredit(referred_user_id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStats, getReferralDetails, awardReferralCredit, awardReferralCreditHandler };
