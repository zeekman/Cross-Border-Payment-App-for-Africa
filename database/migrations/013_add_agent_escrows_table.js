/**
 * Migration: 013_add_agent_escrows_table
 *
 * Creates the agent_escrows table to track on-chain Soroban escrow records
 * for the trustless agent payout flow.
 */

exports.up = (pgm) => {
  pgm.createTable("agent_escrows", {
    id: { type: "uuid", primaryKey: true },
    contract_escrow_id: { type: "text", notNull: true },
    sender_wallet: { type: "text", notNull: true },
    recipient_wallet: { type: "text", notNull: true },
    agent_wallet: { type: "text", notNull: true },
    amount: { type: "numeric(20,7)", notNull: true },
    asset: { type: "varchar(10)", notNull: true, default: "USDC" },
    fee_bps: { type: "integer", notNull: true },
    status: {
      type: "varchar(20)",
      notNull: true,
      default: "pending",
      check: "status IN ('pending', 'completed', 'cancelled')",
    },
    tx_hash: { type: "text" },
    confirm_tx_hash: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("NOW()") },
  });

  pgm.createIndex("agent_escrows", "sender_wallet");
  pgm.createIndex("agent_escrows", "agent_wallet");
  pgm.createIndex("agent_escrows", "status");
};

exports.down = (pgm) => {
  pgm.dropTable("agent_escrows");
};
