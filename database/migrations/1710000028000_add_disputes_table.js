/**
 * Migration: 014_add_disputes_table
 *
 * Creates the disputes table to track on-chain Soroban dispute resolution
 * records. Links to support_tickets and agent_escrows for full audit trail.
 */

exports.up = (pgm) => {
  pgm.createTable("disputes", {
    id: { type: "uuid", primaryKey: true },
    contract_dispute_id: { type: "text", notNull: true },
    sender_wallet: { type: "text", notNull: true },
    recipient_wallet: { type: "text", notNull: true },
    amount: { type: "numeric(20,7)", notNull: true },
    asset: { type: "varchar(10)", notNull: true, default: "USDC" },
    status: {
      type: "varchar(30)",
      notNull: true,
      default: "open",
      check: "status IN ('open', 'resolved_for_recipient', 'resolved_for_sender', 'expired')",
    },
    // Optional link to the support ticket that triggered this dispute
    support_ticket_id: {
      type: "integer",
      references: '"support_tickets"',
      onDelete: "SET NULL",
    },
    // Optional link to the agent escrow being disputed
    escrow_id: {
      type: "uuid",
      references: '"agent_escrows"',
      onDelete: "SET NULL",
    },
    open_tx_hash: { type: "text" },
    resolve_tx_hash: { type: "text" },
    // Unix deadline stored for quick expiry checks without on-chain call
    deadline_at: { type: "timestamptz", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("NOW()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("NOW()"),
    },
  });

  pgm.createIndex("disputes", "sender_wallet");
  pgm.createIndex("disputes", "recipient_wallet");
  pgm.createIndex("disputes", "status");
  pgm.createIndex("disputes", "support_ticket_id");
  pgm.createIndex("disputes", "escrow_id");
};

exports.down = (pgm) => {
  pgm.dropTable("disputes");
};
