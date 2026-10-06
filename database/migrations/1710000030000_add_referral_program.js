/**
 * Migration: 014_add_referral_program
 *
 * Adds referral_code and referred_by to users, and creates referral_credits table.
 */

exports.up = (pgm) => {
  pgm.addColumns('users', {
    referral_code: { type: 'varchar(12)', unique: true },
    referred_by: { type: 'varchar(12)' },
  });

  pgm.createTable('referral_credits', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    referred_user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    amount_bps: { type: 'integer', notNull: true },
    used: { type: 'boolean', notNull: true, default: false },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('referral_credits', 'user_id');
  pgm.createIndex('users', 'referral_code');
};

exports.down = (pgm) => {
  pgm.dropTable('referral_credits');
  pgm.dropColumns('users', ['referral_code', 'referred_by']);
};
