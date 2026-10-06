exports.up = (pgm) => {
  pgm.addColumn('users', {
    kyc_document_expiry_date: { type: 'timestamptz' },
    kyc_reminders_sent: { type: 'jsonb', notNull: true, default: '{}' },
  });

  // Extend the KYC status constraint to include 'expired'
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_kyc_status_check;
    ALTER TABLE users ADD CONSTRAINT users_kyc_status_check
      CHECK (kyc_status IN ('unverified', 'pending', 'verified', 'rejected', 'expired'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_kyc_status_check;
    ALTER TABLE users ADD CONSTRAINT users_kyc_status_check
      CHECK (kyc_status IN ('unverified', 'pending', 'verified', 'rejected'));
  `);
  pgm.dropColumn('users', 'kyc_reminders_sent');
  pgm.dropColumn('users', 'kyc_document_expiry_date');
};
