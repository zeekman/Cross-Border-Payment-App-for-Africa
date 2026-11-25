/**
 * BE-023: allow a referral reward to be recorded as 'flagged' when
 * creditReferralReward() withholds it after detecting self-referral or a
 * circular referral chain, instead of only 'pending' | 'credited' | 'failed'.
 */

exports.up = (pgm) => {
  pgm.sql('ALTER TABLE referral_rewards DROP CONSTRAINT IF EXISTS referral_rewards_status_check');
  pgm.addConstraint('referral_rewards', 'referral_rewards_status_check', {
    check: "status IN ('pending', 'credited', 'failed', 'flagged')",
  });
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM referral_rewards WHERE status = 'flagged'");
  pgm.dropConstraint('referral_rewards', 'referral_rewards_status_check');
  pgm.addConstraint('referral_rewards', 'referral_rewards_status_check', {
    check: "status IN ('pending', 'credited', 'failed')",
  });
};
