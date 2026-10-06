/**
 * Migration: 017_add_offer_events_table
 *
 * Tracks DEX offer lifecycle events (filled, partially filled, cancelled)
 * synced from Stellar Horizon trade history (issue #137).
 */

exports.up = (pgm) => {
  pgm.createTable('offer_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    wallet_address: { type: 'varchar(56)', notNull: true },
    offer_id: { type: 'bigint', notNull: false },
    // 'trade' = offer was (partially) filled; 'cancelled' = offer removed
    event_type: {
      type: 'varchar(20)',
      notNull: true,
      check: "event_type IN ('trade', 'cancelled')",
    },
    base_asset: { type: 'varchar(12)', notNull: true },
    counter_asset: { type: 'varchar(12)', notNull: true },
    base_amount: { type: 'numeric(20,7)', notNull: false },
    counter_amount: { type: 'numeric(20,7)', notNull: false },
    price: { type: 'numeric(20,7)', notNull: false },
    // Horizon paging token for deduplication
    paging_token: { type: 'varchar(100)', notNull: false, unique: true },
    ledger_close_time: { type: 'timestamptz', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('offer_events', ['user_id', 'created_at']);
  pgm.createIndex('offer_events', 'wallet_address');

  // Track the last synced paging token per wallet to avoid re-fetching
  pgm.createTable('offer_sync_cursors', {
    wallet_address: { type: 'varchar(56)', primaryKey: true },
    last_paging_token: { type: 'varchar(100)', notNull: false },
    synced_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('offer_sync_cursors');
  pgm.dropTable('offer_events');
};
