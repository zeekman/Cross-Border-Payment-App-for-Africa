exports.up = (pgm) => {
  pgm.addColumn('transactions', {
    source: {
      type: 'VARCHAR(50)',
      notNull: true,
      default: 'afripay',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('transactions', 'source');
};
