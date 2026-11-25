exports.up = (pgm) => {
  pgm.addColumns('webhooks', {
    previous_secret: { type: 'varchar(255)' },
    previous_secret_expires_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('webhooks', ['previous_secret', 'previous_secret_expires_at']);
};
