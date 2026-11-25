exports.up = (pgm) => {
  pgm.createIndex('transactions', ['sender_wallet', { name: 'created_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }], {
    name: 'idx_transactions_sender_history_keyset',
  });
  pgm.createIndex('transactions', ['recipient_wallet', { name: 'created_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }], {
    name: 'idx_transactions_recipient_history_keyset',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('transactions', ['sender_wallet', 'created_at', 'id'], {
    name: 'idx_transactions_sender_history_keyset',
  });
  pgm.dropIndex('transactions', ['recipient_wallet', 'created_at', 'id'], {
    name: 'idx_transactions_recipient_history_keyset',
  });
};