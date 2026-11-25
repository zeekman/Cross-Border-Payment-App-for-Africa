exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE claimable_balances ADD COLUMN warning_sent_at timestamptz;

    ALTER TABLE transactions
      DROP CONSTRAINT IF EXISTS transactions_status_check;
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_status_check
      CHECK (status IN ('pending', 'confirming', 'completed', 'failed', 'pending_claim', 'expired', 'reclaimed'));

    ALTER TABLE claimable_balances
      DROP CONSTRAINT IF EXISTS claimable_balances_status_check;
    ALTER TABLE claimable_balances
      ADD CONSTRAINT claimable_balances_status_check
      CHECK (status IN ('active', 'claimed', 'expired', 'cancelled', 'reclaimed'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE transactions SET status = 'failed' WHERE status IN ('expired', 'reclaimed');
    UPDATE claimable_balances SET status = 'cancelled' WHERE status = 'reclaimed';

    ALTER TABLE transactions
      DROP CONSTRAINT IF EXISTS transactions_status_check;
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_status_check
      CHECK (status IN ('pending', 'confirming', 'completed', 'failed', 'pending_claim'));

    ALTER TABLE claimable_balances
      DROP CONSTRAINT IF EXISTS claimable_balances_status_check;
    ALTER TABLE claimable_balances
      ADD CONSTRAINT claimable_balances_status_check
      CHECK (status IN ('active', 'claimed', 'expired', 'cancelled'));

    ALTER TABLE claimable_balances DROP COLUMN warning_sent_at;
  `);
};