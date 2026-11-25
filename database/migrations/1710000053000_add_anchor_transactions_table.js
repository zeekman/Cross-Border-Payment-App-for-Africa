/**
 * Migration: 024_add_anchor_transactions_table
 *
 * Tracks SEP-24 interactive deposit and withdrawal transactions initiated
 * through the anchor flow. The `id` is the transaction ID returned by the
 * anchor; status is synced back when the client polls /api/anchor/transaction/:id.
 */

exports.up = (pgm) => {
  pgm.createTable('anchor_transactions', {
    id: { type: 'text', primaryKey: true },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    type: {
      type: 'varchar(10)',
      notNull: true,
      check: "type IN ('deposit', 'withdrawal')",
    },
    asset: { type: 'varchar(12)', notNull: true },
    status: {
      type: 'varchar(30)',
      notNull: true,
      default: 'pending',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: { type: 'timestamptz' },
  });

  pgm.createIndex('anchor_transactions', 'user_id');
  pgm.createIndex('anchor_transactions', 'status');
};

exports.down = (pgm) => {
  pgm.dropTable('anchor_transactions');
};
