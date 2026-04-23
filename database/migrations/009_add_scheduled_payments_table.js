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
    next_run_at: {
      type: 'timestamp',
      notNull: true
    },
    active: {
      type: 'boolean',
      default: true,
      notNull: true
    },
    memo: {
      type: 'text'
    },
    last_run_at: {
      type: 'timestamp'
    },
    failed_attempts: {
      type: 'integer',
      default: 0
    },
    created_at: {
      type: 'timestamp',
      default: pgm.func('NOW()'),
      notNull: true
    }
  });
  pgm.createIndex('scheduled_payments', 'user_id');
  pgm.createIndex('scheduled_payments', 'next_run_at');
  pgm.createIndex('scheduled_payments', 'active');
};

exports.down = (pgm) => {
  pgm.dropTable('scheduled_payments');
};
