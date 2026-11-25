/**
 * BE-164: claimable_balances.expiry_warning_sent_at so expiry warnings fire once.
 * BE-165: wallets.has_dex_activity limits offer sync polling; offer_events is
 * unique per (paging_token, wallet_address) so both sides of a trade are kept.
 */

exports.up = (pgm) => {
  pgm.addColumns('claimable_balances', {
    expiry_warning_sent_at: { type: 'timestamptz' },
  }, { ifNotExists: true });

  pgm.addColumns('wallets', {
    has_dex_activity: { type: 'boolean', notNull: true, default: false },
  }, { ifNotExists: true });

  pgm.sql(`
    UPDATE wallets SET has_dex_activity = TRUE
    WHERE public_key IN (SELECT wallet_address FROM offer_events
                         UNION SELECT wallet_address FROM offer_sync_cursors)
  `);

  pgm.sql('ALTER TABLE offer_events DROP CONSTRAINT IF EXISTS offer_events_paging_token_key');
  pgm.addConstraint('offer_events', 'offer_events_paging_token_wallet_key', {
    unique: ['paging_token', 'wallet_address'],
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('offer_events', 'offer_events_paging_token_wallet_key', { ifExists: true });
  pgm.addConstraint('offer_events', 'offer_events_paging_token_key', { unique: ['paging_token'] });
  pgm.dropColumns('wallets', ['has_dex_activity'], { ifExists: true });
  pgm.dropColumns('claimable_balances', ['expiry_warning_sent_at'], { ifExists: true });
};
