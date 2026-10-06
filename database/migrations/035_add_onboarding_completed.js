/**
 * Migration: 035_add_onboarding_completed
 *
 * Adds onboarding_completed to users so "has this user completed onboarding"
 * is a per-account fact stored server-side (not a per-device localStorage flag).
 * New accounts default to incomplete; completion is recorded via the
 * authenticated POST /api/auth/onboarding-completed endpoint.
 */

exports.up = (pgm) => {
  pgm.addColumns("users", {
    onboarding_completed: { type: "boolean", notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns("users", ["onboarding_completed"]);
};
