exports.up = (pgm) => {
  pgm.addColumn('transactions', {
    ledger_close_time: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('transactions', 'ledger_close_time');
};
