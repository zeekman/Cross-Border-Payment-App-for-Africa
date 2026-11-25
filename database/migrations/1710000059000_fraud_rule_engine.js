exports.up = (pgm) => {
  pgm.createTable('fraud_rules', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'varchar(100)', notNull: true, unique: true },
    rule_type: { type: 'varchar(20)', notNull: true },
    parameters: { type: 'jsonb', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('fraud_rules', 'fraud_rules_rule_type_check',
    "rule_type IN ('velocity', 'amount', 'daily_limit')");

  pgm.createTable('fraud_checks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    rule_name: { type: 'varchar(100)', notNull: true },
    rule_type: { type: 'varchar(20)', notNull: true },
    outcome: { type: 'varchar(10)', notNull: true }, // 'blocked' | 'passed'
    payment_id: { type: 'uuid' },
    wallet_address: { type: 'text', notNull: true },
    metadata: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('fraud_checks', 'wallet_address');
  pgm.createIndex('fraud_checks', 'created_at');

  // Seed default rules matching existing hardcoded behaviour
  pgm.sql(`
    INSERT INTO fraud_rules (name, rule_type, parameters) VALUES
    ('default_velocity', 'velocity', '{"max_transactions": 5, "window_minutes": 10}'),
    ('default_daily_limit', 'daily_limit', '{"max_usd": 10000}'),
    ('default_amount', 'amount', '{"max_usd": 50000}')
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('fraud_checks');
  pgm.dropTable('fraud_rules');
};
