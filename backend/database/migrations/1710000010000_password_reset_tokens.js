/* eslint-disable camelcase */

// NOTE: This migration is a duplicate of the earlier SQL migration
// `1710000009000_password_reset_tokens.sql`, which already creates the
// `password_reset_tokens` table. Both files are kept so that node-pg-migrate's
// ordering check stays valid on databases that recorded either one, but this
// port is made idempotent so the full chain runs cleanly on a fresh database.
// See database/MIGRATIONS.md for guidance on porting `.sql` migrations.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable(
    'password_reset_tokens',
    {
      id: 'id',
      user_id: {
        type: 'integer',
        notNull: true,
        references: 'users',
        onDelete: 'CASCADE',
      },
      token_hash: { type: 'varchar(255)', notNull: true, unique: true },
      expires_at: { type: 'timestamptz', notNull: true },
      used_at: { type: 'timestamptz' },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('current_timestamp'),
      },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('password_reset_tokens', 'user_id', {
    name: 'idx_password_reset_tokens_user_id',
    ifNotExists: true,
  });

  pgm.createIndex('password_reset_tokens', 'token_hash', {
    name: 'idx_password_reset_tokens_token_hash',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropTable('password_reset_tokens', { ifExists: true });
};
