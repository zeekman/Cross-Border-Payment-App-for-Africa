/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('savings_vaults', {
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
    amount: { type: 'decimal(20,7)', notNull: true },
    asset: { type: 'varchar(12)', notNull: true, default: "'XLM'" },
    lock_period_days: { type: 'integer', notNull: true },
    unlock_timestamp: { type: 'bigint', notNull: true },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: "'locked'",
      check: "status IN ('locked','unlocked','withdrawn')",
    },
    early_withdrawal: { type: 'boolean', default: false },
    penalty_amount: { type: 'decimal(20,7)', default: 0 },
    withdrawn_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('savings_vaults', 'user_id', {
    name: 'idx_savings_vaults_user',
  });
  pgm.createIndex('savings_vaults', ['status', 'unlock_timestamp'], {
    name: 'idx_savings_vaults_status_unlock',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('savings_vaults', ['status', 'unlock_timestamp'], {
    name: 'idx_savings_vaults_status_unlock',
  });
  pgm.dropIndex('savings_vaults', 'user_id', {
    name: 'idx_savings_vaults_user',
  });
  pgm.dropTable('savings_vaults');
};
