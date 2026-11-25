/**
 * Password policy — the single source of truth for password-strength rules.
 *
 * Used by:
 *   - routes/auth.js to enforce the policy on /register, /reset-password and
 *     /password (change password), and
 *   - GET /auth/password-policy so the frontend can derive its validation
 *     checks from the exact same rules instead of maintaining its own copy.
 *
 * If a rule changes here, every endpoint that enforces passwords and the
 * published policy response change together — there is no second copy to
 * forget to update.
 */

const DEFAULT_MIN_LENGTH = 8;

// Human-readable fragments used in validation error messages. Keyed by the
// same rule identifiers exposed in the policy response so they cannot drift
// from the published rules.
const RULE_LABELS = {
  uppercase: 'at least one uppercase letter',
  lowercase: 'at least one lowercase letter',
  number: 'at least one digit',
  special: 'at least one special character',
};

const RULE_REGEXES = {
  uppercase: /[A-Z]/,
  lowercase: /[a-z]/,
  number: /[0-9]/,
  special: /[^A-Za-z0-9]/,
};

/**
 * The current policy as a serializable object (also served verbatim by
 * GET /auth/password-policy).
 *
 *   {
 *     min_length: 8,
 *     rules: { uppercase: true, lowercase: true, number: true, special: true }
 *   }
 *
 * Only rules whose value is `true` are enforced/required.
 */
function getPolicy() {
  const minLength = parseInt(process.env.PASSWORD_MIN_LENGTH, 10) || DEFAULT_MIN_LENGTH;
  return {
    min_length: minLength,
    rules: {
      uppercase: true,
      lowercase: true,
      number: true,
      special: true,
    },
  };
}

/**
 * Returns an array of human-readable unmet requirements (empty when the
 * password satisfies the policy). Mirrors the policy returned by getPolicy().
 */
function checkPasswordStrength(password) {
  const policy = getPolicy();
  const unmet = [];

  if (password.length < policy.min_length) {
    unmet.push(`at least ${policy.min_length} characters`);
  }

  Object.entries(policy.rules).forEach(([rule, required]) => {
    if (required && !RULE_REGEXES[rule].test(password)) {
      unmet.push(RULE_LABELS[rule]);
    }
  });

  return unmet;
}

module.exports = { getPolicy, checkPasswordStrength, DEFAULT_MIN_LENGTH, RULE_LABELS };
