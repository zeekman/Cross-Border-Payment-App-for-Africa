exports.up = (pgm) => {
  pgm.addColumn('users', {
    account_type: {
      type: 'varchar(20)',
      notNull: true,
      default: 'personal',
    },
  });

  pgm.createTable('wallet_signers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    signer_public_key: { type: 'varchar(56)', notNull: true },
    label: { type: 'varchar(100)' },
    added_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('wallet_signers', 'wallet_signers_user_signer_unique', 'UNIQUE(user_id, signer_public_key)');
  pgm.createIndex('wallet_signers', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('wallet_signers');
  pgm.dropColumn('users', 'account_type');
};
