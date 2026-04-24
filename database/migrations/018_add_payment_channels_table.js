/**
 * Migration: 018_add_payment_channels_table
 *
 * Stores Stellar payment channel state for off-chain micropayment batching.
 */

exports.up = (pgm) => {
  pgm.createTable('payment_channels', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    user_id: { type: 'uuid', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    sender_public_key: { type: 'varchar(56)', notNull: true },
    recipient_public_key: { type: 'varchar(56)', notNull: true },
    asset: { type: 'varchar(12)', notNull: true, default: 'XLM' },
    funding_amount: { type: 'numeric(20,7)', notNull: true },
    sender_balance: { type: 'numeric(20,7)', notNull: true },
    recipient_balance: { type: 'numeric(20,7)', notNull: true, default: 0 },
    // Pre-signed unilateral closing transaction XDR (time-locked)
    closing_tx_xdr: { type: 'text', notNull: true },
    settlement_tx_hash: { type: 'varchar(64)' },
    status: {
      type: 'varchar(10)',
      notNull: true,
      default: 'open',
      check: "status IN ('open', 'closed')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('payment_channels', 'user_id');
  pgm.createIndex('payment_channels', ['sender_public_key', 'status']);
};

exports.down = (pgm) => {
  pgm.dropTable('payment_channels');
};
