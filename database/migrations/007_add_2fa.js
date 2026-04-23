exports.up = (pgm) => {
  pgm.addColumns('users', {
    totp_secret: { type: 'varchar(32)' },
    totp_enabled: { type: 'boolean', default: false },
    backup_codes: { type: 'text[]' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['totp_secret', 'totp_enabled', 'backup_codes']);
};
