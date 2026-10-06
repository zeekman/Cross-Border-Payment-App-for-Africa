/**
 * Migration: 015_add_loyalty_points_table
 *
 * Tracks off-chain loyalty point ledger entries that mirror the on-chain
 * Soroban loyalty token. Each row records a mint or burn event tied to a
 * transaction, plus a redemption record when a user applies a fee discount.
 */

exports.up = (pgm) => {
  pgm.createTable("loyalty_points", {
    id: { type: "uuid", primaryKey: true },
    user_id: {
      type: "integer",
      notNull: true,
      references: '"users"',
      onDelete: "CASCADE",
    },
    wallet_address: { type: "text", notNull: true },
    // 'mint' — earned after a payment; 'burn' — redeemed for a fee discount
    event_type: {
      type: "varchar(10)",
      notNull: true,
      check: "event_type IN ('mint', 'burn')",
    },
    points: { type: "integer", notNull: true },
    // Link to the transaction that triggered the mint/burn
    transaction_id: {
      type: "uuid",
      references: '"transactions"',
      onDelete: "SET NULL",
    },
    tx_hash: { type: "text" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("NOW()"),
    },
  });

  pgm.createIndex("loyalty_points", "user_id");
  pgm.createIndex("loyalty_points", "wallet_address");
  pgm.createIndex("loyalty_points", "event_type");
  pgm.createIndex("loyalty_points", "transaction_id");
};

exports.down = (pgm) => {
  pgm.dropTable("loyalty_points");
};
