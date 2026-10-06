'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { mintPoints } = require('./loyaltyToken');
const { sendPushToUser } = require('../controllers/notificationController');
const { detectReferralAbuse } = require('./referralAbuseGuard');
const logger = require('../utils/logger');

const REFERRAL_REWARD_TOKENS = parseInt(process.env.REFERRAL_REWARD_TOKENS || '50', 10);

/**
 * Credit loyalty-token reward to the referrer when their referee completes
 * their first successful payment.
 *
 * Idempotent: unique DB constraints on referee_id and payment_id prevent
 * duplicate rows. Concurrent calls race to INSERT; the loser gets a unique-
 * violation and exits silently.
 *
 * @param {string} refereeUserId  - UUID of the user who just paid
 * @param {string} paymentId      - UUID of the completed transaction
 */
async function creditReferralReward(refereeUserId, paymentId) {
  // 1. Is this user referred, and who referred them?
  const referralResult = await db.query(
    `SELECT u.id AS referrer_id, u.email AS referrer_email,
            u.push_subscription,
            ref.email AS referee_email
     FROM users ref
     JOIN users u ON u.referral_code = ref.referred_by
     WHERE ref.id = $1`,
    [refereeUserId],
  );
  if (!referralResult.rows[0]) return; // not a referred user

  const { referrer_id, referee_email } = referralResult.rows[0];

  // 2. Reject self-referral and circular referral chains before issuing a reward
  const abuseReason = await detectReferralAbuse(referrer_id, refereeUserId);
  if (abuseReason) {
    logger.warn('Referral reward withheld — abuse check failed', {
      referrerId: referrer_id, refereeUserId, paymentId, reason: abuseReason,
    });
    await db.query(
      `INSERT INTO referral_rewards (id, referrer_id, referee_id, reward_amount, status, payment_id)
       VALUES ($1, $2, $3, 0, 'flagged', $4)`,
      [uuidv4(), referrer_id, refereeUserId, paymentId],
    ).catch((err) => {
      if (err.code !== '23505') throw err; // already recorded — nothing more to do
    });
    return;
  }

  // 3. Insert reward row — unique(referee_id) enforces one-time-only
  let rewardId;
  try {
    const insertResult = await db.query(
      `INSERT INTO referral_rewards (id, referrer_id, referee_id, reward_amount, status, payment_id)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id`,
      [uuidv4(), referrer_id, refereeUserId, REFERRAL_REWARD_TOKENS, paymentId],
    );
    rewardId = insertResult.rows[0].id;
  } catch (err) {
    // 23505 = unique_violation — reward already issued or same payment re-processed
    if (err.code === '23505') return;
    throw err;
  }

  // 4. Mint tokens to referrer's wallet
  try {
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1 LIMIT 1',
      [referrer_id],
    );
    if (walletResult.rows[0]) {
      await mintPoints({
        recipientWallet: walletResult.rows[0].public_key,
        points: REFERRAL_REWARD_TOKENS,
      });
    }

    await db.query(
      `UPDATE referral_rewards SET status = 'credited' WHERE id = $1`,
      [rewardId],
    );
  } catch (err) {
    await db.query(
      `UPDATE referral_rewards SET status = 'failed' WHERE id = $1`,
      [rewardId],
    );
    logger.warn('Referral reward minting failed', { rewardId, error: err.message });
    return;
  }

// 5. Notify referrer (fire-and-forget)
   const message = `${referee_email} just made their first payment using your referral link! You've earned ${REFERRAL_REWARD_TOKENS} loyalty points.`;

   const { persistAndBroadcast } = require('../services/notificationInbox');
   persistAndBroadcast(referrer_id, 'referral_reward_earned', 'Referral reward earned! 🎉',
     message, { points: REFERRAL_REWARD_TOKENS }
   ).catch(() => {});
   sendPushToUser(referrer_id, {
     title: 'Referral reward earned! 🎉',
     body: message,
   }).catch(() => {});
 }

module.exports = { creditReferralReward, REFERRAL_REWARD_TOKENS };
