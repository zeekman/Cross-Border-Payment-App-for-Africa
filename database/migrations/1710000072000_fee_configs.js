exports.up = (pgm) => {
  pgm.createTable('fee_configs', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    fee_type: {
      type: 'varchar(50)',
      notNull: true,
    },
    asset_code: {
      type: 'varchar(12)',
      notNull: true,
    },
    fee_bps: {
      type: 'integer',
      notNull: true,
    },
    max_fee_usdc: {
      type: 'numeric(20,7)',
      notNull: true,
    },
    min_fee_usdc: {
      type: 'numeric(20,7)',
      notNull: true,
    },
    is_active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    created_by: {
      type: 'uuid',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      default: pgm.func('NOW()'),
    },
    effective_from: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.sql(`
    ALTER TABLE fee_configs
      ADD CONSTRAINT fee_configs_type_asset_unique
      UNIQUE (fee_type, asset_code, is_active)
      DEFERRABLE INITIALLY DEFERRED;
  `);

  pgm.createIndex('fee_configs', ['fee_type', 'asset_code', 'is_active'], {
    name: 'idx_fee_configs_lookup',
  });
  pgm.createIndex('fee_configs', 'created_at', {
    name: 'idx_fee_configs_created_at',
  });

  pgm.sql(`
    INSERT INTO fee_configs
      (fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc, is_active, created_by, effective_from)
    VALUES
      ('platform', 'USDC', 250, 100.0000000, 0.0100000, true, '00000000-0000-0000-0000-000000000000', NOW()),
      ('platform', 'XLM', 250, 10.0000000, 0.0010000, true, '00000000-0000-0000-0000-000000000000', NOW()),
      ('referral', 'USDC', 0, 50.0000000, 0.0000000, true, '00000000-0000-0000-0000-000000000000', NOW()),
      ('loyalty_redemption', 'USDC', 0, 5.0000000, 0.0000000, true, '00000000-0000-0000-0000-000000000000', NOW())
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('fee_configs');
};
