/**
 * Add family_id to refresh_tokens for token-family tracking.
 *
 * family_id groups all tokens issued from a single login into one family.
 * When a rotated (already-used) token is presented, every token in that
 * family is invalidated, forcing the user to log in again.
 *
 * revoked marks tokens that have been rotated out but are kept for reuse
 * detection. A cron job (or TTL policy) can purge revoked rows older than
 * the max refresh token TTL.
 */
exports.up = (pgm) => {
  pgm.addColumn('refresh_tokens', {
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
  });

  pgm.createIndex('refresh_tokens', 'family_id', {
    name: 'idx_refresh_tokens_family',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('refresh_tokens', 'family_id', {
    name: 'idx_refresh_tokens_family',
  });
  pgm.dropColumn('refresh_tokens', 'revoked');
  pgm.dropColumn('refresh_tokens', 'family_id');
};
