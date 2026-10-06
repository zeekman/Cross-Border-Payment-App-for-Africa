/**
 * Migration: 014_add_phone_verification
 *
 * Adds phone_verified and phone_otp_hash columns to users table
 * to support SMS-based verification.
 */

exports.up = (pgm) => {
  pgm.addColumns("users", {
    phone_verified: { type: "boolean", notNull: true, default: false },
    phone_otp_hash: { type: "varchar(64)" },
    phone_otp_expires_at: { type: "timestamptz" },
  });

  pgm.createIndex("users", "phone_verified");
};

exports.down = (pgm) => {
  pgm.dropColumns("users", ["phone_verified", "phone_otp_hash", "phone_otp_expires_at"]);
};
