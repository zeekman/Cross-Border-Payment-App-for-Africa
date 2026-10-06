/**
 * Password validation utilities.
 *
 * All strength/acceptance checks are derived from the backend password policy
 * (fetched via GET /auth/password-policy — see utils/passwordPolicy.js), so
 * the rules the frontend enforces can never drift from what the backend
 * actually enforces at registration and password-reset time. The backend
 * remains the authoritative gate; these functions exist so the UI can give
 * real-time feedback and block submission of passwords the backend would
 * reject.
 *
 * Every function accepts an optional `policy` argument (defaulting to the
 * cached/server policy) so callers and tests can control it explicitly.
 */

import { getPasswordPolicy } from './passwordPolicy';

const RULE_REGEXES = {
  uppercase: /[A-Z]/,
  lowercase: /[a-z]/,
  number: /[0-9]/,
  special: /[^A-Za-z0-9]/,
};

// Checklist display labels. Presentation only — the rules themselves come from
// the backend policy; unknown future rules fall back to a generic label.
export const RULE_LABELS = {
  uppercase: 'One uppercase letter',
  lowercase: 'One lowercase letter',
  number: 'One number',
  special: 'One special character',
};

// Wording for the unmet-requirement error message (see getPasswordError).
const RULE_ERROR_LABELS = {
  uppercase: 'uppercase letter',
  lowercase: 'lowercase letter',
  number: 'number',
  special: 'special character',
};

function enabledRules(policy) {
  return Object.entries(policy.rules).filter(([, required]) => required);
}

/** Build the per-requirement check map from the policy (length + each rule). */
function getChecks(password, policy) {
  const checks = { length: password.length >= policy.min_length };
  enabledRules(policy).forEach(([rule]) => {
    checks[rule] = RULE_REGEXES[rule].test(password);
  });
  return checks;
}

/** True only when every policy requirement is met (matches backend acceptance). */
function allChecksMet(checks) {
  return Object.values(checks).every(Boolean);
}

/**
 * Checklist items derived from the policy, e.g. for the register/reset pages:
 *   [{ key: 'length', label: 'At least 8 characters' },
 *    { key: 'uppercase', label: 'One uppercase letter' }, ...]
 */
export function getPasswordChecklist(policy = getPasswordPolicy()) {
  const items = [{ key: 'length', label: `At least ${policy.min_length} characters` }];
  enabledRules(policy).forEach(([rule]) => {
    items.push({ key: rule, label: RULE_LABELS[rule] || `One ${rule}` });
  });
  return items;
}

/**
 * 5-bar strength meter (reset-password page). Score is the number of policy
 * requirements met; level labels are clamped so a fully-compliant password
 * (e.g. 5/5) still maps to "very strong".
 */
export function getPasswordStrength(password, policy = getPasswordPolicy()) {
  const checks = getChecks(password, policy);
  const score = Object.values(checks).filter(Boolean).length;

  const levels = ['', 'weak', 'fair', 'strong', 'very strong'];
  const colors = ['', 'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500'];
  const textColors = ['', 'text-red-500', 'text-orange-500', 'text-yellow-500', 'text-green-500'];
  const levelIndex = Math.min(score, levels.length - 1);

  return {
    checks,
    score,
    label: levels[levelIndex],
    barColor: colors[levelIndex],
    textColor: textColors[levelIndex],
    // True only when every policy requirement is met.
    isValid: allChecksMet(checks),
  };
}

/**
 * Issue #656: 4-level password strength model for the Register page.
 *
 * Scored across the character-class requirements surfaced in the checklist and
 * the character classes used for the level thresholds:
 *   - Weak (red):        < min_length chars OR only one character class
 *   - Fair (orange):     >= min_length chars and 2 character classes
 *   - Strong (blue):     >= min_length chars and 3 character classes
 *   - Very Strong (green): >= 12 chars and all character classes
 *
 * Returns score 0 for an empty password (nothing to render). isAcceptable is
 * true only when every policy requirement is met — i.e. exactly what the
 * backend accepts at registration time.
 */
export function getRegisterPasswordStrength(password = '', policy = getPasswordPolicy()) {
  const checks = getChecks(password, policy);

  const classRules = enabledRules(policy).filter(([rule]) => RULE_REGEXES[rule]);
  const classes = classRules.filter(([rule]) => RULE_REGEXES[rule].test(password)).length;

  const len = password.length;
  const veryStrongLength = Math.max(12, policy.min_length);

  // 0 = empty, 1 = weak, 2 = fair, 3 = strong, 4 = very strong
  let score;
  if (len === 0) {
    score = 0;
  } else if (len >= veryStrongLength && classes === classRules.length) {
    score = 4;
  } else if (len >= policy.min_length && classes >= 3) {
    score = 3;
  } else if (len >= policy.min_length && classes >= 2) {
    score = 2;
  } else {
    score = 1;
  }

  const meta = [
    { label: '', barColor: '', textColor: '' },
    { label: 'Weak', barColor: 'bg-red-500', textColor: 'text-red-500' },
    { label: 'Fair', barColor: 'bg-orange-500', textColor: 'text-orange-500' },
    { label: 'Strong', barColor: 'bg-blue-500', textColor: 'text-blue-500' },
    { label: 'Very Strong', barColor: 'bg-green-500', textColor: 'text-green-500' },
  ][score];

  return {
    score,
    classes,
    checks,
    label: meta.label,
    barColor: meta.barColor,
    textColor: meta.textColor,
    // The Create Account button is enabled only when the password meets every
    // policy requirement — matching the backend's acceptance exactly.
    isAcceptable: allChecksMet(checks),
  };
}

export function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function getEmailError(email) {
  if (!email) return 'Email is required';
  if (!validateEmail(email)) return 'Please enter a valid email address';
  return '';
}

/**
 * Human-readable error describing which policy requirements are unmet, or ''
 * when the password satisfies the policy.
 */
export function getPasswordError(password, policy = getPasswordPolicy()) {
  if (!password) return 'Password is required';

  if (password.length < policy.min_length) {
    return `Password must be at least ${policy.min_length} characters`;
  }

  const unmet = [];
  enabledRules(policy).forEach(([rule]) => {
    if (!RULE_REGEXES[rule].test(password)) {
      unmet.push(RULE_ERROR_LABELS[rule] || rule);
    }
  });

  if (unmet.length > 0) {
    return `Password must contain at least one ${unmet.join(', ')}`;
  }

  return '';
}
