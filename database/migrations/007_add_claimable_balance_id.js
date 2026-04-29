exports.up = (pgm) => {
  pgm.addColumn('transactions', {
    claimable_balance_id: {
      type: 'varchar(255)',
      notNull: false
    }
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('transactions', 'claimable_balance_id');
};
