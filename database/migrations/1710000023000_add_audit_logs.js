exports.up = (pgm) => {
  pgm.createTable('audit_logs', {
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
    action: { type: 'varchar(50)', notNull: true },
    ip_address: { type: 'varchar(45)' },
    user_agent: { type: 'text' },
    metadata: { type: 'jsonb' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('audit_logs', 'user_id', { name: 'idx_audit_logs_user' });
  pgm.createIndex('audit_logs', 'created_at', { name: 'idx_audit_logs_created_at' });
};

exports.down = (pgm) => {
  pgm.dropIndex('audit_logs', 'created_at', { name: 'idx_audit_logs_created_at' });
  pgm.dropIndex('audit_logs', 'user_id', { name: 'idx_audit_logs_user' });
  pgm.dropTable('audit_logs');
};
