/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('users', {
    country_code: { type: 'char(2)' },
    kyc_tier: { type: 'varchar(20)', notNull: true, default: 'basic' },
  });

  pgm.createTable('corridor_configs', {
    id: 'id',
    origin_country: { type: 'char(2)', notNull: true },
    destination_country: { type: 'char(2)', notNull: true },
    daily_limit_usd: { type: 'numeric(20, 2)' },
    single_transaction_limit_usd: { type: 'numeric(20, 2)' },
    kyc_threshold_usd: { type: 'numeric(20, 2)' },
    phone_verification_threshold_usd: { type: 'numeric(20, 2)' },
    required_kyc_tier: { type: 'varchar(20)', notNull: true, default: 'basic' },
    allowed_assets: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'uuid' },
    created_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.addConstraint('corridor_configs', 'corridor_configs_country_pair_unique', {
    unique: ['origin_country', 'destination_country'],
  });

  pgm.createTable('tm_cases', {
    id: { type: 'uuid', primaryKey: true },
    user_id: { type: 'uuid', notNull: true },
    payment_id: { type: 'uuid' },
    sender_wallet: { type: 'text', notNull: true },
    recipient_wallet: { type: 'text', notNull: true },
    amount: { type: 'numeric(20, 7)', notNull: true },
    asset: { type: 'varchar(12)', notNull: true },
    source: { type: 'varchar(32)', notNull: true },
    rule_name: { type: 'varchar(100)' },
    reason: { type: 'text', notNull: true },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    status: { type: 'varchar(20)', notNull: true, default: 'open' },
    disposition: { type: 'varchar(24)' },
    disposition_reason: { type: 'text' },
    assigned_to: { type: 'uuid' },
    sla_due_at: { type: 'timestamp with time zone', notNull: true },
    str_reference: { type: 'varchar(128)' },
    str_filed_at: { type: 'timestamp with time zone' },
    created_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamp with time zone', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.addConstraint('tm_cases', 'tm_cases_status_check', {
    check: "status IN ('open', 'under_review', 'closed')",
  });
  pgm.addConstraint('tm_cases', 'tm_cases_disposition_check', {
    check: "disposition IS NULL OR disposition IN ('released', 'rejected', 'confirmed', 'false_positive')",
  });
  pgm.createIndex('tm_cases', ['status', 'sla_due_at']);
  pgm.createIndex('tm_cases', ['created_at']);

  pgm.addColumn('fraud_rules', {
    action: { type: 'varchar(12)', notNull: true, default: 'block' },
  });
  pgm.addConstraint('fraud_rules', 'fraud_rules_action_check', {
    check: "action IN ('block', 'hold', 'allow')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('fraud_rules', 'fraud_rules_action_check');
  pgm.dropColumn('fraud_rules', 'action');
  pgm.dropTable('tm_cases');
  pgm.dropTable('corridor_configs');
  pgm.dropColumn('users', 'kyc_tier');
  pgm.dropColumn('users', 'country_code');
};
