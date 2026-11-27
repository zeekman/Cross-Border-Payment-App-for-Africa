/* Muxed (M…) addresses are 69 characters. */
exports.up = (pgm) => {
  pgm.alterColumn('contacts', 'wallet_address', { type: 'varchar(69)' });
};

// Not narrowed on rollback: saved muxed contacts would no longer fit.
exports.down = () => {};
