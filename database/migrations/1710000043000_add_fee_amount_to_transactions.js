exports.up = (pgm) => {
  pgm.addColumn('transactions', {
    fee_amount: {
      type: 'numeric(20,7)',
      notNull: true,
      default: 0,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('transactions', 'fee_amount');
};
