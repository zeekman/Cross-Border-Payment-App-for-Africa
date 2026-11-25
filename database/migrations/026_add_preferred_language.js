exports.up = (pgm) => {
  pgm.addColumn('users', {
    preferred_language: {
      type: 'varchar(10)',
      notNull: false,
      default: null,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('users', 'preferred_language');
};
