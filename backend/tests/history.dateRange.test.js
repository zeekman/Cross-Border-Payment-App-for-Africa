/**
 * Tests for issue #244:
 * GET /api/payments/history must enforce a 366-day maximum date range,
 * and cross-field validation (from <= to, range check) must live at the
 * validator layer (historyQueryValidators).
 */
const { parseHistoryFrom, parseHistoryTo, validateDateRange, MAX_HISTORY_RANGE_DAYS } = require('../src/utils/historyQuery');
const historyQueryValidators = require('../src/validators/historyQueryValidators');
const { validationResult } = require('express-validator');

// Helper: run express-validator validators against a fake req object
async function runValidators(queryParams) {
  const req = { query: queryParams, body: {}, params: {} };
  for (const validator of historyQueryValidators) {
    await validator.run(req);
  }
  return validationResult(req);
}

describe('#244 history date range validation', () => {
  describe('validateDateRange utility', () => {
    test('returns null when both dates are absent', () => {
      expect(validateDateRange(null, null)).toBeNull();
    });

    test('returns null when only one date is provided', () => {
      const from = parseHistoryFrom('2025-01-01');
      expect(validateDateRange(from, null)).toBeNull();
      expect(validateDateRange(null, from)).toBeNull();
    });

    test('returns null for a range exactly equal to 366 days', () => {
      const from = parseHistoryFrom('2024-01-01');
      const to = parseHistoryTo('2024-12-31'); // 366 days (2024 is a leap year)
      expect(validateDateRange(from, to)).toBeNull();
    });

    test('returns an error message for a range of 367 days', () => {
      const from = parseHistoryFrom('2024-01-01');
      const to = parseHistoryTo('2025-01-02'); // 367 days
      const result = validateDateRange(from, to);
      expect(result).toMatch(/366/);
    });

    test('returns an error message for a multi-year range', () => {
      const from = parseHistoryFrom('2020-01-01');
      const to = parseHistoryTo('2023-12-31');
      expect(validateDateRange(from, to)).not.toBeNull();
    });
  });

  describe('historyQueryValidators middleware', () => {
    test('passes when no dates are provided', async () => {
      const result = await runValidators({});
      expect(result.isEmpty()).toBe(true);
    });

    test('passes for a valid range within 366 days', async () => {
      const result = await runValidators({ from: '2025-01-01', to: '2025-06-01' });
      expect(result.isEmpty()).toBe(true);
    });

    test('returns 400-level error when range exceeds 366 days', async () => {
      const result = await runValidators({ from: '2020-01-01', to: '2023-12-31' });
      expect(result.isEmpty()).toBe(false);
      const msgs = result.array().map((e) => e.msg);
      expect(msgs.some((m) => m.includes('366'))).toBe(true);
    });

    test('returns error when from is after to', async () => {
      const result = await runValidators({ from: '2025-06-01', to: '2025-01-01' });
      expect(result.isEmpty()).toBe(false);
      const msgs = result.array().map((e) => e.msg);
      expect(msgs.some((m) => m.toLowerCase().includes('before'))).toBe(true);
    });

    test('returns error for invalid ISO date in from', async () => {
      const result = await runValidators({ from: 'not-a-date' });
      expect(result.isEmpty()).toBe(false);
    });

    test('passes when only from is provided (no upper bound)', async () => {
      const result = await runValidators({ from: '2025-01-01' });
      expect(result.isEmpty()).toBe(true);
    });

    test('passes when only to is provided (no lower bound)', async () => {
      const result = await runValidators({ to: '2025-06-01' });
      expect(result.isEmpty()).toBe(true);
    });
  });

  describe('MAX_HISTORY_RANGE_DAYS constant', () => {
    test('is 366', () => {
      expect(MAX_HISTORY_RANGE_DAYS).toBe(366);
    });
  });
});
