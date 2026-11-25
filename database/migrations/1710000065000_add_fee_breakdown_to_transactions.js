/**
 * Migration: 029_add_fee_breakdown_to_transactions
 *
 * Adds a fee_breakdown JSONB column to transactions for storing structured
 * fee components: platform_fee_usdc, platform_fee_bps, stellar_base_fee_xlm,
 * net_amount_usdc, gross_amount_usdc.
 */

exports.up = (pgm) => {
  pgm.addColumns('transactions', {
    fee_breakdown: { type: 'jsonb' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('transactions', ['fee_breakdown']);
};
