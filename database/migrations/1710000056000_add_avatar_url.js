exports.up = (pgm) => {
  pgm.addColumn('users', {
    avatar_url: { type: 'text', default: null },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('users', 'avatar_url');
};
