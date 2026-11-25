exports.up = (pgm) => {
  pgm.addColumns('users', {
    pending_email: { type: 'text', notNull: false },
    pending_email_token: { type: 'text', notNull: false },
    pending_email_token_expires_at: { type: 'timestamptz', notNull: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['pending_email', 'pending_email_token', 'pending_email_token_expires_at']);
};
