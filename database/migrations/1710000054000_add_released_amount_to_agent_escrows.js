/**
 * Migration: 025_add_released_amount_to_agent_escrows
 *
 * Adds a released_amount column to support partial releases (issue #657).
 * Tracks the cumulative amount released so the remaining escrow balance can be
 * derived as (amount - released_amount).
 */

exports.up = (pgm) => {
  pgm.addColumn("agent_escrows", {
    released_amount: { type: "numeric(20,7)", notNull: true, default: 0 },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("agent_escrows", "released_amount");
};
