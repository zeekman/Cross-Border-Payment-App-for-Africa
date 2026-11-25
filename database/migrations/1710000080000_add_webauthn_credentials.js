/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('webauthn_credentials', {
    id: 'id',
    user_id: {
      type: 'integer',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    credential_id: { type: 'text', notNull: true, unique: true },
    public_key: { type: 'text', notNull: true },
    counter: { type: 'bigint', notNull: true, default: 0 },
    transports: { type: 'text' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    last_used_at: { type: 'timestamptz' },
  });

  pgm.createIndex('webauthn_credentials', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('webauthn_credentials');
};
