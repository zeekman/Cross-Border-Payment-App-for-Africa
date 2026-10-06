exports.up = (pgm) => {
  pgm.addColumns('users', {
    failed_login_attempts: { type: 'integer', notNull: true, default: 0 },
    locked_until: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['failed_login_attempts', 'locked_until']);
};
