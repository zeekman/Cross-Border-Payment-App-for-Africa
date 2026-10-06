exports.up = (pgm) => {
  pgm.addColumn('transactions', {
    private_note: { type: 'varchar(500)', notNull: false, default: null },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('transactions', 'private_note');
};
