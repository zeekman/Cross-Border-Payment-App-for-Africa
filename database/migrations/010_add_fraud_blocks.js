exports.up = (pgm) => {
  pgm.createTable('fraud_blocks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    wallet_address: { type: 'varchar(56)', notNull: true },
    reason: { type: 'text', notNull: true },
    amount: { type: 'decimal(20, 7)' },
    asset: { type: 'varchar(12)' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') }
  });

  pgm.createIndex('fraud_blocks', 'wallet_address');
  pgm.createIndex('fraud_blocks', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('fraud_blocks');
};
