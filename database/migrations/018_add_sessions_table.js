exports.up = (pgm) => {
  pgm.createTable('sessions', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    token_hash: {
      type: 'varchar(64)',
      notNull: true,
      unique: true,
      comment: 'SHA-256 hash of the JWT — raw token is never stored',
    },
    device_info: { type: 'text' },
    ip_address: { type: 'inet' },
    last_active: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('sessions', 'user_id', { name: 'idx_sessions_user_id' });
  pgm.createIndex('sessions', 'token_hash', { name: 'idx_sessions_token_hash' });
};

exports.down = (pgm) => {
  pgm.dropIndex('sessions', 'user_id', { name: 'idx_sessions_user_id' });
  pgm.dropIndex('sessions', 'token_hash', { name: 'idx_sessions_token_hash' });
  pgm.dropTable('sessions');
};
