exports.up = (pgm) => {
  pgm.createTable('webhook_deliveries', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    webhook_id: {
      type: 'uuid',
      notNull: true,
      references: '"webhooks"',
      onDelete: 'CASCADE',
    },
    event_type: { type: 'varchar(100)', notNull: true },
    target_url: { type: 'text', notNull: true },
    status_code: { type: 'int' },
    response_time_ms: { type: 'int' },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'delivered', 'failed')",
    },
    attempt: { type: 'int', notNull: true, default: 1 },
    max_attempts: { type: 'int', notNull: true, default: 3 },
    error_message: { type: 'text' },
    payload: { type: 'jsonb' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
    completed_at: { type: 'timestamptz' },
  });

  pgm.createIndex('webhook_deliveries', 'webhook_id', { name: 'idx_webhook_deliveries_webhook' });
  pgm.createIndex('webhook_deliveries', 'status', { name: 'idx_webhook_deliveries_status' });
  pgm.createIndex('webhook_deliveries', 'created_at', { name: 'idx_webhook_deliveries_created_at' });
};

exports.down = (pgm) => {
  pgm.dropIndex('webhook_deliveries', 'created_at', { name: 'idx_webhook_deliveries_created_at' });
  pgm.dropIndex('webhook_deliveries', 'status', { name: 'idx_webhook_deliveries_status' });
  pgm.dropIndex('webhook_deliveries', 'webhook_id', { name: 'idx_webhook_deliveries_webhook' });
  pgm.dropTable('webhook_deliveries');
};
