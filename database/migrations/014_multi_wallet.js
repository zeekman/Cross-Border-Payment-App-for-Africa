/**
 * Migration 014 — Multi-wallet support
 *
 * Adds:
 *   - wallets.label        VARCHAR(100)  — user-defined name for the wallet
 *   - wallets.is_default   BOOLEAN       — marks the primary wallet per user
 *
 * Existing single wallets are back-filled as the default wallet with label "Main".
 */
exports.up = (pgm) => {
  pgm.addColumn('wallets', {
    label: {
      type: 'varchar(100)',
      notNull: true,
      default: 'Main',
    },
    is_default: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });

  // Every existing wallet is the user's only wallet — make it the default
  pgm.sql(`UPDATE wallets SET is_default = true`);

  // Enforce exactly one default per user at the DB level
  pgm.createIndex('wallets', ['user_id'], {
    name: 'idx_wallets_one_default_per_user',
    unique: true,
    where: 'is_default = true',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('wallets', ['user_id'], { name: 'idx_wallets_one_default_per_user' });
  pgm.dropColumn('wallets', 'is_default');
  pgm.dropColumn('wallets', 'label');
};
