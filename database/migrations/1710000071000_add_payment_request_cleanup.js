exports.up = (pgm) => {
  pgm.addColumns('payment_requests', {
    status: { type: 'varchar(20)', default: 'pending' },
  });

  pgm.createTable('archived_payment_requests', {
    id: { type: 'uuid', primaryKey: true },
    requester_id: { type: 'uuid' },
    requester_wallet: { type: 'text' },
    amount: { type: 'decimal(20,7)' },
    asset: { type: 'varchar(12)' },
    memo: { type: 'text' },
    expires_at: { type: 'timestamptz' },
    claimed: { type: 'boolean', default: false },
    claimed_tx_hash: { type: 'text' },
    status: { type: 'varchar(20)' },
    archived_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    created_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('archived_payment_requests');
  pgm.dropColumns('payment_requests', ['status']);
};
