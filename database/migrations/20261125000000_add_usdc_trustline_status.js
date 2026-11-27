exports.up = (pgm) => {
  pgm.addColumns('wallets', {
    usdc_trustline_status: { type: 'VARCHAR(10)', notNull: true, default: 'pending' }, // pending | active | failed
    usdc_trustline_attempts: { type: 'INTEGER', notNull: true, default: 0 },
    usdc_trustline_next_retry_at: { type: 'TIMESTAMPTZ' },
  });
  pgm.createIndex('wallets', ['usdc_trustline_status', 'usdc_trustline_next_retry_at']);
};

exports.down = (pgm) => {
  pgm.dropColumns('wallets', ['usdc_trustline_status', 'usdc_trustline_attempts', 'usdc_trustline_next_retry_at']);
};
