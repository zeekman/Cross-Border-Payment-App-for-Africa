exports.up = (pgm) => {
  // Composite indexes to support direction-filtered history queries efficiently
  pgm.createIndex('transactions', ['sender_wallet', 'created_at'], {
    name: 'idx_transactions_sender_created',
    ifNotExists: true,
  });
  pgm.createIndex('transactions', ['recipient_wallet', 'created_at'], {
    name: 'idx_transactions_recipient_created',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('transactions', ['sender_wallet', 'created_at'], { name: 'idx_transactions_sender_created' });
  pgm.dropIndex('transactions', ['recipient_wallet', 'created_at'], { name: 'idx_transactions_recipient_created' });
};
