exports.up = (pgm) => {
  pgm.createTable('scheduled_payments', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()')
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'cascade'
    },
    recipient_wallet: {
      type: 'varchar(56)',
      notNull: true
    },
    amount: {
      type: 'decimal(20,7)',
      notNull: true
    },
    asset: {
      type: 'varchar(12)',
      notNull: true,
      default: 'XLM'
    },
    frequency: {
      type: 'varchar(20)',
      notNull: true,
      check: "frequency IN ('daily', 'weekly', 'monthly')"
    },
    execute_at: {
      type: 'timestamp',
      notNull: true
    },
    next_run_at: {},
    active: {},
    memo: {
      type: 'text'
    },
    last_run_at: {},
    failed_attempts: {},
    created_at: {}
  });
};

exports.down = (pgm) => {
  pgm.dropTable('scheduled_payments');
};
