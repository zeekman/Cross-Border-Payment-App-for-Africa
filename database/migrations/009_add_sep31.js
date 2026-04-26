exports.up = (pgm) => {
  pgm.createTable('sep31_transactions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    sender_id: { type: 'uuid', references: 'users(id)', onDelete: 'cascade' },
    receiver_account: { type: 'varchar(56)', notNull: true },
    amount: { type: 'decimal(20, 7)', notNull: true },
    asset_code: { type: 'varchar(12)', default: 'USDC' },
    status: { type: 'varchar(20)', default: 'pending', check: "status IN ('pending', 'completed', 'failed')" },
    kyc_verified: { type: 'boolean', default: false },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', default: pgm.func('NOW()') }
  });

  pgm.createIndex('sep31_transactions', 'sender_id');
  pgm.createIndex('sep31_transactions', 'status');
};

exports.down = (pgm) => {
  pgm.dropTable('sep31_transactions');
};
