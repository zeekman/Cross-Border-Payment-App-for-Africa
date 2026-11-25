exports.up = (pgm) => {
  pgm.createTable('supported_assets', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    asset_code: { type: 'varchar(12)', notNull: true },
    // NULL for native XLM
    asset_issuer: { type: 'varchar(56)' },
    display_name: { type: 'varchar(100)', notNull: true },
    icon_url: { type: 'text' },
    decimal_precision: { type: 'integer', notNull: true, default: 7 },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  // Uniqueness scoped to (code, issuer) — COALESCE handles the NULL case
  pgm.sql(`
    ALTER TABLE supported_assets
      ADD CONSTRAINT supported_assets_asset_unique
      UNIQUE (asset_code, asset_issuer);
  `);

  pgm.createIndex('supported_assets', 'asset_code', { name: 'idx_supported_assets_code' });

  // Seed well-known assets. Issuer addresses may be overridden by admins after deployment.
  pgm.sql(`
    INSERT INTO supported_assets (asset_code, asset_issuer, display_name, decimal_precision) VALUES
      ('XLM',  NULL,                                                          'Stellar Lumens', 7),
      ('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'USD Coin',        2)
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('supported_assets');
};
