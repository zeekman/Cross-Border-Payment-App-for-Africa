// BE-193 / BE-195: phone OTP hardening.
// - phone_otp_attempts: failed verifications against the current OTP; the OTP
//   is invalidated after 5 failures and a resend is required.
// - phone_otp_sent_at / phone_otp_send_count / phone_otp_send_window_start:
//   per-user resend cooldown and daily cap.
// - phone_otp_sends: send log used for the per-phone-number daily cap across
//   accounts.
// phone_otp_hash now stores HMAC-SHA256(server secret, userId:otp) — still 64
// hex chars. Existing bare SHA-256 hashes stop matching, so pending OTPs are
// cleared; affected users request a new code via /api/auth/phone/resend-otp.
exports.up = (pgm) => {
  pgm.addColumns('users', {
    phone_otp_attempts: { type: 'int', notNull: true, default: 0 },
    phone_otp_sent_at: { type: 'timestamptz' },
    phone_otp_send_count: { type: 'int', notNull: true, default: 0 },
    phone_otp_send_window_start: { type: 'timestamptz' },
  });

  pgm.sql('UPDATE users SET phone_otp_hash = NULL, phone_otp_expires_at = NULL WHERE phone_otp_hash IS NOT NULL');

  pgm.createTable('phone_otp_sends', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'uuid', references: 'users', onDelete: 'CASCADE' },
    phone: { type: 'varchar(32)', notNull: true },
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('phone_otp_sends', ['phone', 'sent_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('phone_otp_sends');
  pgm.dropColumns('users', [
    'phone_otp_attempts',
    'phone_otp_sent_at',
    'phone_otp_send_count',
    'phone_otp_send_window_start',
  ]);
};
