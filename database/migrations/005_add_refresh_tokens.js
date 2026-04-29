/**
 * Creates the refresh_tokens table with family tracking built in.
 *
 * family_id  — groups all tokens issued from a single login into one family.
 *              When a rotated (revoked) token is replayed, every token in
 *              that family is deleted, forcing the user to log in again.
 *
 * revoked    — marks tokens that have been rotated out but are kept for
 *              reuse detection. Rows can be purged once expires_at passes.
 */
exports.up = (pgm) => {
  pgm.createTable('refresh_tokens', {
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
    token_hash: {
      type: 'varchar(64)',
      notNull: true,
      unique: true,
    },
    family_id: {
      type: 'uuid',
      notNull: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    revoked: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    expires_at: {
      type: 'timestamptz',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('refresh_tokens', 'user_id',    { name: 'idx_refresh_tokens_user' });
  pgm.createIndex('refresh_tokens', 'token_hash', { name: 'idx_refresh_tokens_hash' });
  pgm.createIndex('refresh_tokens', 'family_id',  { name: 'idx_refresh_tokens_family' });
};

exports.down = (pgm) => {
  pgm.dropTable('refresh_tokens');
};
