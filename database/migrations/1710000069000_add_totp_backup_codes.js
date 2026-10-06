exports.up = (pgm) => {
  pgm.createTable('totp_backup_codes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'cascade' },
    code_hash: { type: 'text', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.createIndex('totp_backup_codes', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('totp_backup_codes');
};
