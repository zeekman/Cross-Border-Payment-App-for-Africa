exports.up = (pgm) => {
  pgm.createTable('loyalty_mint_queue', {
    id: {
      type: 'uuid',
      primaryKey: true,
      references: 'transactions',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
    },
    sender_wallet: {
      type: 'varchar(56)',
      notNull: true,
    },
    amount: {
      type: 'numeric(20,7)',
      notNull: true,
    },
    asset: {
      type: 'varchar(12)',
      notNull: true,
    },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'pending',
    },
    retry_count: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    tx_hash: {
      type: 'varchar(64)',
    },
    last_error: {
      type: 'text',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    completed_at: {
      type: 'timestamptz',
    },
  });

  pgm.createIndex('loyalty_mint_queue', 'status');
  pgm.createIndex('loyalty_mint_queue', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('loyalty_mint_queue');
};