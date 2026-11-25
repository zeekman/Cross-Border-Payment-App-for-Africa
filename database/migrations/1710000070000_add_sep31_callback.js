exports.up = (pgm) => {
  pgm.addColumns('sep31_transactions', {
    callback_url: { type: 'text' },
    shared_secret: { type: 'text' },
    status_message: { type: 'text' },
    stellar_transaction_id: { type: 'text' },
    refunded: { type: 'boolean', default: false },
  });

  pgm.createTable('sep31_callbacks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    transaction_id: { type: 'uuid', notNull: true, references: 'sep31_transactions(id)', onDelete: 'cascade' },
    url: { type: 'text', notNull: true },
    http_status: { type: 'int' },
    response_time_ms: { type: 'int' },
    attempt_number: { type: 'int', notNull: true },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.createIndex('sep31_callbacks', 'transaction_id');
};

exports.down = (pgm) => {
  pgm.dropTable('sep31_callbacks');
  pgm.dropColumns('sep31_transactions', ['callback_url', 'shared_secret', 'status_message', 'stellar_transaction_id', 'refunded']);
};
