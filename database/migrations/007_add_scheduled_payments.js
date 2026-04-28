/* eslint-disable camelcase */
exports.shorthands = undefined;

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
    memo: { type: 'varchar(128)' },
    memo_type: { type: 'varchar(10)' },
    // When the payment should be executed
    scheduled_at: { type: 'timestamptz', notNull: true },
    // Lifecycle: pending -> processing -> completed | failed
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: "'pending'",
      check: "status IN ('pending','processing','completed','failed')",
    },
    // Retry tracking
    retry_count: { type: 'int', notNull: true, default: 0 },
    last_error: { type: 'text' },
    // Outcome
    tx_hash: { type: 'varchar(64)' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('scheduled_payments', 'user_id', {
    name: 'idx_scheduled_payments_user',
  });
  pgm.createIndex('scheduled_payments', ['status', 'scheduled_at'], {
    name: 'idx_scheduled_payments_due',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('scheduled_payments', ['status', 'scheduled_at'], {
    name: 'idx_scheduled_payments_due',
  });
  pgm.dropIndex('scheduled_payments', 'user_id', {
    name: 'idx_scheduled_payments_user',
  });
  pgm.dropTable('scheduled_payments');
};
