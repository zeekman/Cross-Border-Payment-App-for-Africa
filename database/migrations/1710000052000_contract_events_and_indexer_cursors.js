exports.up = (pgm) => {
  pgm.createTable('indexer_cursors', {
    key: { type: 'varchar(100)', primaryKey: true },
    value: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createTable('contract_events', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    contract_id: { type: 'varchar(72)', notNull: true },
    event_name: { type: 'varchar(100)', notNull: true },
    tx_hash: { type: 'varchar(64)', notNull: true },
    ledger: { type: 'integer', notNull: true },
    payload: { type: 'jsonb', default: "'{}'::jsonb" },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.addConstraint('contract_events', 'contract_events_tx_event_unique', 'UNIQUE(tx_hash, event_name)');
  pgm.createIndex('contract_events', 'contract_id', { name: 'idx_contract_events_contract' });
  pgm.createIndex('contract_events', 'ledger', { name: 'idx_contract_events_ledger' });
};

exports.down = (pgm) => {
  pgm.dropIndex('contract_events', 'ledger', { name: 'idx_contract_events_ledger' });
  pgm.dropIndex('contract_events', 'contract_id', { name: 'idx_contract_events_contract' });
  pgm.dropTable('contract_events');
  pgm.dropTable('indexer_cursors');
};
