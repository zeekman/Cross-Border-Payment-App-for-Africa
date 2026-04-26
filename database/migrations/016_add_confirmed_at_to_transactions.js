/**
 * Migration: 016_add_confirmed_at_to_transactions
 *
 * Adds confirmed_at timestamp and 'confirming' status to transactions table
 * for ledger confirmation tracking (issue #135).
 */

exports.up = (pgm) => {
  // Add confirmed_at column
  pgm.addColumn('transactions', {
    confirmed_at: { type: 'timestamptz', notNull: false, default: null },
  });

  // Extend the status check constraint to include 'confirming'
  pgm.sql(`
    ALTER TABLE transactions
      DROP CONSTRAINT IF EXISTS transactions_status_check;
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_status_check
      CHECK (status IN ('pending', 'confirming', 'completed', 'failed', 'pending_claim'));
  `);
};

exports.down = (pgm) => {
  pgm.dropColumn('transactions', 'confirmed_at');
  pgm.sql(`
    ALTER TABLE transactions
      DROP CONSTRAINT IF EXISTS transactions_status_check;
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_status_check
      CHECK (status IN ('pending', 'completed', 'failed', 'pending_claim'));
  `);
};
