exports.up = (pgm) => {
  pgm.addColumn('sep31_transactions', {
    callback_url: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('sep31_transactions', 'callback_url');
};
