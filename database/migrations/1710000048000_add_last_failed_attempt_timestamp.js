exports.up = (pgm) => {
  pgm.addColumns('users', {
    last_failed_attempt_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['last_failed_attempt_at']);
};
