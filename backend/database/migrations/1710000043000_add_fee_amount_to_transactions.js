/* eslint-disable camelcase */

/**
 * NOTE: `transactions.fee_amount` is already added by the earlier migration
 * `1710000030000_add_role_to_users.sql` (despite its name). This migration is
 * kept for history but made idempotent so the full chain runs cleanly on a
 * fresh database. See issue #1174 (BE-128).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('transactions', {
    fee_amount: {
      type: 'numeric(20,7)',
      notNull: false,
      default: 0,
    },
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumn('transactions', 'fee_amount', { ifExists: true });
};
