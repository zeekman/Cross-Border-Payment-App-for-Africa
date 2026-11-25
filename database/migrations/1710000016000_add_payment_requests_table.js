exports.up = (pgm) => {
  pgm.createTable('payment_requests', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()')
    },
    requester_wallet: {
      type: 'varchar(56)',
      notNull: true
    },
    requester_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'cascade'
    },
    amount: {
      type: 'decimal(20,7)',
      notNull: true
    },
    asset: {
      type: 'varchar(12)',
      notNull: true,
      default: 'XLM'
    },
    memo: {
      type: 'text'
    },
    expires_at: {
      type: 'timestamp',
      notNull: true
    },
    claimed: {
      type: 'boolean',
      default: false
    },
    claimed_tx_hash: {
      type: 'varchar(64)'
    },
    created_at: {
      type: 'timestamp',
      default: pgm.func('NOW()'),
      notNull: true
    }
  });
  pgm.createIndex('payment_requests', 'requester_id');
  pgm.createIndex('payment_requests', 'expires_at');
};

exports.down = (pgm) => {
  pgm.dropTable('payment_requests');
};
