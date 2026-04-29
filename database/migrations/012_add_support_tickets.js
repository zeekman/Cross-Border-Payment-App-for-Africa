exports.up = (pgm) => {
  pgm.createTable('support_tickets', {
    id: { type: 'serial', primaryKey: true },
    user_id: { type: 'integer', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    transaction_id: { type: 'integer', references: '"transactions"', onDelete: 'SET NULL' },
    type: {
      type: 'varchar(50)',
      notNull: true,
      // e.g. 'wrong_address', 'wrong_amount', 'failed_deducted', 'other'
    },
    description: { type: 'text', notNull: true },
    status: { type: 'varchar(20)', notNull: true, default: "'open'" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('support_tickets', 'user_id');
  pgm.createIndex('support_tickets', 'transaction_id');
};

exports.down = (pgm) => {
  pgm.dropTable('support_tickets');
};
