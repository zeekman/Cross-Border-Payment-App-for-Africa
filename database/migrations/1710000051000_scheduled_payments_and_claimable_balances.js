exports.up = (pgm) => {
  pgm.createTable('scheduled_payments', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    sender_wallet: { type: 'varchar(56)', notNull: true },
    recipient_wallet: { type: 'varchar(56)', notNull: true },
    amount: { type: 'decimal(20,7)', notNull: true },
    asset: { type: 'varchar(12)', notNull: true, default: "'XLM'" },
    memo: { type: 'varchar(28)' },
    // ISO 8601 cron expression or next_run_at timestamp
    run_at: { type: 'timestamptz', notNull: true },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: "'pending'",
      check: "status IN ('pending','processing','completed','failed','cancelled')",
    },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('scheduled_payments', ['status', 'run_at'], {
    name: 'idx_scheduled_payments_status_run_at',
  });
  pgm.createIndex('scheduled_payments', 'user_id', {
    name: 'idx_scheduled_payments_user',
  });

  pgm.createTable('claimable_balances', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    // Stellar claimable balance ID (starts with 00000000...)
    balance_id: { type: 'varchar(72)', notNull: true, unique: true },
    user_id: {
      type: 'uuid',
      references: '"users"',
      onDelete: 'SET NULL',
    },
    asset: { type: 'varchar(12)', notNull: true },
    amount: { type: 'decimal(20,7)', notNull: true },
    claimant_wallet: { type: 'varchar(56)', notNull: true },
    expires_at: { type: 'timestamptz' },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: "'active'",
      check: "status IN ('active','claimed','expired','cancelled')",
    },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('claimable_balances', ['status', 'expires_at'], {
    name: 'idx_claimable_balances_status_expires',
  });
  pgm.createIndex('claimable_balances', 'user_id', {
    name: 'idx_claimable_balances_user',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('claimable_balances', 'user_id', { name: 'idx_claimable_balances_user' });
  pgm.dropIndex('claimable_balances', ['status', 'expires_at'], {
    name: 'idx_claimable_balances_status_expires',
  });
  pgm.dropTable('claimable_balances');

  pgm.dropIndex('scheduled_payments', 'user_id', { name: 'idx_scheduled_payments_user' });
  pgm.dropIndex('scheduled_payments', ['status', 'run_at'], {
    name: 'idx_scheduled_payments_status_run_at',
  });
  pgm.dropTable('scheduled_payments');
};
