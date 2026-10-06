import {
  getRegisterPasswordStrength,
  getPasswordStrength,
  getPasswordError,
  getPasswordChecklist,
} from '../passwordValidator';
import { DEFAULT_PASSWORD_POLICY } from '../passwordPolicy';

// The default policy mirrors what the backend serves when PASSWORD_MIN_LENGTH
// is unset (min 8 + uppercase/lowercase/number/special).
const defaultPolicy = DEFAULT_PASSWORD_POLICY;

describe('getRegisterPasswordStrength (issue #656)', () => {
  it('scores an empty password as 0 with no label', () => {
    const s = getRegisterPasswordStrength('');
    expect(s.score).toBe(0);
    expect(s.label).toBe('');
  });

  describe('Weak (score 1)', () => {
    it('is weak when shorter than 8 characters', () => {
      const s = getRegisterPasswordStrength('Ab1!', defaultPolicy);
      expect(s.score).toBe(1);
      expect(s.label).toBe('Weak');
      expect(s.barColor).toBe('bg-red-500');
    });

    it('is weak when 8+ chars but only one character class', () => {
      const s = getRegisterPasswordStrength('passwordpassword', defaultPolicy);
      expect(s.score).toBe(1);
      expect(s.label).toBe('Weak');
    });
  });

  describe('Fair (score 2)', () => {
    it('is fair with 8+ chars and exactly two character classes', () => {
      const s = getRegisterPasswordStrength('passWord', defaultPolicy);
      expect(s.classes).toBe(2);
      expect(s.score).toBe(2);
      expect(s.label).toBe('Fair');
      expect(s.barColor).toBe('bg-orange-500');
    });
  });

  describe('Strong (score 3)', () => {
    it('is strong with 8+ chars and three character classes', () => {
      const s = getRegisterPasswordStrength('Password1', defaultPolicy);
      expect(s.classes).toBe(3);
      expect(s.score).toBe(3);
      expect(s.label).toBe('Strong');
      expect(s.barColor).toBe('bg-blue-500');
    });

    it('stays strong (not very strong) with all 4 classes but under 12 chars', () => {
      const s = getRegisterPasswordStrength('Pass1!ab', defaultPolicy);
      expect(s.classes).toBe(4);
      expect(s.score).toBe(3);
      expect(s.label).toBe('Strong');
    });
  });

  describe('Very Strong (score 4)', () => {
    it('is very strong with 12+ chars and all four character classes', () => {
      const s = getRegisterPasswordStrength('Password123!', defaultPolicy);
      expect(s.classes).toBe(4);
      expect(s.score).toBe(4);
      expect(s.label).toBe('Very Strong');
      expect(s.barColor).toBe('bg-green-500');
    });

    it('drops to strong if 12+ chars but missing a class', () => {
      const s = getRegisterPasswordStrength('Passwordabc1', defaultPolicy);
      expect(s.classes).toBe(3);
      expect(s.score).toBe(3);
    });
  });

  describe('checklist dimensions', () => {
    it('reports each policy requirement independently (including lowercase)', () => {
      const s = getRegisterPasswordStrength('Abcdef1!', defaultPolicy);
      expect(s.checks).toEqual({
        length: true,
        uppercase: true,
        lowercase: true,
        number: true,
        special: true,
      });
    });

    it('flags unmet requirements', () => {
      const s = getRegisterPasswordStrength('abc', defaultPolicy);
      expect(s.checks).toEqual({
        length: false,
        uppercase: false,
        lowercase: true,
        number: false,
        special: false,
      });
    });
  });

  describe('isAcceptable — matches backend acceptance exactly', () => {
    it('is acceptable only when every policy requirement is met', () => {
      // All 5 requirements met → acceptable.
      expect(getRegisterPasswordStrength('Password123!', defaultPolicy).isAcceptable).toBe(true);
      // Meets length but misses digit + special → NOT acceptable (backend would reject).
      expect(getRegisterPasswordStrength('passWord', defaultPolicy).isAcceptable).toBe(false);
      // Misses uppercase → NOT acceptable.
      expect(getRegisterPasswordStrength('password', defaultPolicy).isAcceptable).toBe(false);
      // Too short → NOT acceptable.
      expect(getRegisterPasswordStrength('Ab1!', defaultPolicy).isAcceptable).toBe(false);
    });

    it('accepts a password the backend accepts even if the meter says only Fair', () => {
      // "Passw0rd!" is 8 chars with all classes → Fair/Strong meter but acceptable.
      expect(getRegisterPasswordStrength('Passw0rd!', defaultPolicy).isAcceptable).toBe(true);
    });
  });

  describe('rules are derived from the policy, not hardcoded', () => {
    it('uses the policy min_length for the length check', () => {
      const policy = { min_length: 10, rules: { uppercase: true, number: true } };
      const s = getRegisterPasswordStrength('Passw0rd!', policy);
      expect(s.checks.length).toBe(false); // 9 chars < 10
      expect(s.isAcceptable).toBe(false);
    });

    it('only enforces rules present in the policy', () => {
      // No special-character rule in this policy → "password1" is acceptable.
      const policy = { min_length: 8, rules: { lowercase: true, number: true } };
      const s = getRegisterPasswordStrength('password1', policy);
      expect(s.checks).toEqual({
        length: true,
        lowercase: true,
        number: true,
      });
      expect(s.isAcceptable).toBe(true);
    });
  });
});

describe('getPasswordStrength (reset-password meter)', () => {
  it('maps a fully-compliant password to very strong', () => {
    const s = getPasswordStrength('Password123!', defaultPolicy);
    expect(s.score).toBe(5); // length + 4 rules
    expect(s.label).toBe('very strong');
    expect(s.isValid).toBe(true);
  });

  it('reports each unmet requirement', () => {
    const s = getPasswordStrength('password', defaultPolicy);
    expect(s.checks.uppercase).toBe(false);
    expect(s.checks.number).toBe(false);
    expect(s.checks.special).toBe(false);
    expect(s.isValid).toBe(false);
  });

  it('derives the score from the provided policy', () => {
    const policy = { min_length: 6, rules: { uppercase: true } };
    const s = getPasswordStrength('Abcd12', policy);
    expect(s.checks.length).toBe(true);
    expect(s.checks.uppercase).toBe(true);
    expect(s.score).toBe(2);
  });
});

describe('getPasswordError', () => {
  it('returns "" for a compliant password', () => {
    expect(getPasswordError('Password123!', defaultPolicy)).toBe('');
  });

  it('uses the policy min_length in the length error', () => {
    expect(getPasswordError('Ab1!', defaultPolicy)).toBe('Password must be at least 8 characters');
    expect(getPasswordError('Ab1!', { min_length: 10, rules: {} })).toBe(
      'Password must be at least 10 characters'
    );
  });

  it('lists unmet rule requirements', () => {
    expect(getPasswordError('password', defaultPolicy)).toBe(
      'Password must contain at least one uppercase letter, number, special character'
    );
  });
});

describe('getPasswordChecklist', () => {
  it('builds the checklist from the policy rules', () => {
    const policy = { min_length: 8, rules: { uppercase: true, lowercase: true, number: true, special: true } };
    expect(getPasswordChecklist(policy)).toEqual([
      { key: 'length', label: 'At least 8 characters' },
      { key: 'uppercase', label: 'One uppercase letter' },
      { key: 'lowercase', label: 'One lowercase letter' },
      { key: 'number', label: 'One number' },
      { key: 'special', label: 'One special character' },
    ]);
  });

  it('reflects a non-default min_length', () => {
    expect(getPasswordChecklist({ min_length: 10, rules: { uppercase: true } })).toEqual([
      { key: 'length', label: 'At least 10 characters' },
      { key: 'uppercase', label: 'One uppercase letter' },
    ]);
  });
});
