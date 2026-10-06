/**
 * Migration: 028_add_referral_rewards_table
 *
 * Tracks loyalty-token rewards issued to referrers when their referee
 * completes their first successful payment. Idempotency is enforced via
 * unique(referee_id) and unique(payment_id).
 */

exports.up = (pgm) => {
  pgm.createTable('referral_rewards', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    referrer_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    referee_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    reward_amount: { type: 'integer', notNull: true },
    status: {
      type: 'varchar(10)',
      notNull: true,
      default: "'pending'",
      check: "status IN ('pending', 'credited', 'failed')",
    },
    payment_id: { type: 'uuid', notNull: true, references: 'transactions(id)', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  // One reward per referee (first-payment only)
  pgm.createIndex('referral_rewards', 'referee_id', { unique: true });
  // Idempotency: same payment_id cannot trigger two rewards
  pgm.createIndex('referral_rewards', 'payment_id', { unique: true });
  pgm.createIndex('referral_rewards', 'referrer_id');
};

exports.down = (pgm) => {
  pgm.dropTable('referral_rewards');
};
