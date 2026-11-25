exports.up = (pgm) => {
  pgm.addColumn('transactions', {
    confirmation_expires_at: { type: 'timestamptz', notNull: false },
  });
  pgm.sql(`
    UPDATE transactions
    SET confirmation_expires_at = created_at + INTERVAL '30 seconds'
    WHERE status = 'confirming' AND tx_hash IS NOT NULL;
  `);
  pgm.createIndex('transactions', 'created_at', {
    name: 'idx_transactions_confirming_created_at',
    where: "status = 'confirming' AND tx_hash IS NOT NULL",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('transactions', 'created_at', { name: 'idx_transactions_confirming_created_at' });
  pgm.dropColumn('transactions', 'confirmation_expires_at');
};