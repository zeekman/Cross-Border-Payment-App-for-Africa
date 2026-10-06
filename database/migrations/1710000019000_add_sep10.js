exports.up = (pgm) => {
  pgm.addColumns('users', {
    stellar_account: { type: 'varchar(56)', unique: true }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['stellar_account']);
};
