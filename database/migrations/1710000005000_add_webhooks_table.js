exports.up = (pgm) => {
  pgm.createTable('webhooks', {
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
    url: { type: 'text', notNull: true },
    secret: { type: 'varchar(255)', notNull: true },
    events: { type: 'text[]', notNull: true, default: "'{}'::text[]" },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('webhooks', 'user_id', { name: 'idx_webhooks_user' });
};

exports.down = (pgm) => {
  pgm.dropIndex('webhooks', 'user_id', { name: 'idx_webhooks_user' });
  pgm.dropTable('webhooks');
};
