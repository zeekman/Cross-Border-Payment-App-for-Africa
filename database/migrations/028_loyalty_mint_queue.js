exports.up = (pgm) => {
  pgm.createTable('loyalty_mint_queue', {
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
    wallet_address: { type: 'text', notNull: true },
    points: { type: 'bigint', notNull: true },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'processing', 'completed', 'dead_letter')",
    },
    attempts: { type: 'int', notNull: true, default: 0 },
    max_attempts: { type: 'int', notNull: true, default: 5 },
    last_error: { type: 'text' },
    tx_hash: { type: 'varchar(255)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    processed_at: { type: 'timestamptz' },
  });

  // Queue worker scans pending items in FIFO order — this index keeps that cheap
  pgm.createIndex('loyalty_mint_queue', ['status', 'created_at'], { name: 'idx_loyalty_mint_queue_status_created' });
  pgm.createIndex('loyalty_mint_queue', 'user_id', { name: 'idx_loyalty_mint_queue_user' });
};

exports.down = (pgm) => {
  pgm.dropIndex('loyalty_mint_queue', 'user_id', { name: 'idx_loyalty_mint_queue_user' });
  pgm.dropIndex('loyalty_mint_queue', ['status', 'created_at'], { name: 'idx_loyalty_mint_queue_status_created' });
  pgm.dropTable('loyalty_mint_queue');
};
