/**
 * Migration: 019_add_agents_table
 *
 * Creates the agents table for registered AfriPay payout agents.
 * Agent registration is admin-approved; only approved agents may be used
 * as the agent parameter in POST /api/escrow/create.
 */

exports.up = (pgm) => {
  pgm.createTable('agents', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    wallet_address: { type: 'text', notNull: true, unique: true },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'approved', 'suspended')",
    },
    country: { type: 'varchar(10)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    approved_at: { type: 'timestamptz' },
  });

  pgm.createIndex('agents', 'wallet_address');
  pgm.createIndex('agents', 'status');
};

exports.down = (pgm) => {
  pgm.dropTable('agents');
};
