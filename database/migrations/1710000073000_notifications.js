exports.up = (pgm) => {
  pgm.createTable('notifications', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    user_id: {
      type: 'uuid',
      notNull: true,
    },
    type: {
      type: 'varchar(50)',
      notNull: true,
    },
    title: {
      type: 'varchar(255)',
      notNull: true,
    },
    body: {
      type: 'text',
    },
    data: {
      type: 'jsonb',
    },
    read_at: {
      type: 'timestamptz',
    },
    created_at: {
      type: 'timestamptz',
      default: pgm.func('NOW()'),
    },
  });

  pgm.addConstraint('notifications', 'fk_notifications_user', {
    foreignKeys: [{ columns: 'user_id', references: 'users(id)' }],
  });

  pgm.createIndex('notifications', ['user_id', 'created_at'], {
    name: 'idx_notifications_user_created',
  });
  pgm.createIndex('notifications', 'created_at', {
    name: 'idx_notifications_created_at',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('notifications');
};