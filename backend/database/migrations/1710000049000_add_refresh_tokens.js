/* eslint-disable camelcase */

// NOTE: This migration is a duplicate of the earlier SQL migration
// `1710000014000_add_refresh_tokens.sql`, which already creates the
// `refresh_tokens` table (with `CREATE TABLE IF NOT EXISTS`) and its indexes.
// Both files are kept so node-pg-migrate's order check stays valid on
// databases that already recorded either one, but this port is made fully
// idempotent so the full chain runs cleanly on an empty database.
// See database/MIGRATIONS.md for guidance on porting `.sql` migrations
// without duplicating them.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable(
    'refresh_tokens',
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
      revoked_at: { type: 'timestamptz' },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('current_timestamp'),
      },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('refresh_tokens', 'user_id', {
    name: 'idx_refresh_tokens_user_id',
    ifNotExists: true,
  });

  pgm.createIndex('refresh_tokens', 'token_hash', {
    name: 'idx_refresh_tokens_token_hash',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropTable('refresh_tokens', { ifExists: true, cascade: true });
};
