exports.up = (pgm) => {
  // Add device tracking and session cap columns to sessions table
  pgm.addColumns('sessions', {
    token_jti: { type: 'varchar(64)', unique: true },
    device_name: { type: 'varchar(255)' },
    device_type: { type: 'varchar(50)' },
    location: { type: 'jsonb' },
    user_agent: { type: 'text' },
    is_active: { type: 'boolean', notNull: true, default: true },
    last_active_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('sessions', 'token_jti', { name: 'idx_sessions_token_jti' });
  pgm.createIndex('sessions', ['user_id', 'is_active'], {
    name: 'idx_sessions_user_active',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('sessions', 'token_jti', { name: 'idx_sessions_token_jti', ifExists: true });
  pgm.dropIndex('sessions', ['user_id', 'is_active'], {
    name: 'idx_sessions_user_active',
    ifExists: true,
  });
  pgm.dropColumns('sessions', [
    'token_jti',
    'device_name',
    'device_type',
    'location',
    'user_agent',
    'is_active',
    'last_active_at',
  ]);
};
