exports.up = (pgm) => {
  pgm.createTable('channel_accounts', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    stellar_address: {
      type: 'varchar(56)',
      notNull: true,
      unique: true,
    },
    stellar_secret_encrypted: {
      type: 'text',
      notNull: true,
    },
    is_available: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    last_used_at: {
      type: 'timestamptz',
    },
    created_at: {
      type: 'timestamptz',
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('channel_accounts', ['is_available', 'last_used_at'], {
    name: 'idx_channel_accounts_availability',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('channel_accounts', ['is_available', 'last_used_at'], {
    name: 'idx_channel_accounts_availability',
  });
  pgm.dropTable('channel_accounts');
};
