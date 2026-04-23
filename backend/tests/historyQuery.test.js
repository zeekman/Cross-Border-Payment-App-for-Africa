const {
  parseHistoryFrom,
  parseHistoryTo,
  normalizeAsset,
  ALLOWED_HISTORY_ASSETS,
} = require('../src/utils/historyQuery');

describe('historyQuery', () => {
  test('parseHistoryFrom: YYYY-MM-DD is start of day UTC', () => {
    const d = parseHistoryFrom('2024-06-15');
    expect(d.toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  test('parseHistoryTo: YYYY-MM-DD is end of day UTC', () => {
    const d = parseHistoryTo('2024-06-15');
    expect(d.toISOString()).toBe('2024-06-15T23:59:59.999Z');
  });

  test('parseHistoryFrom/To: full ISO strings', () => {
    const f = parseHistoryFrom('2024-01-01T12:00:00.000Z');
    const t = parseHistoryTo('2024-12-31T12:00:00.000Z');
    expect(f.toISOString()).toBe('2024-01-01T12:00:00.000Z');
    expect(t.toISOString()).toBe('2024-12-31T12:00:00.000Z');
  });

  test('parseHistoryFrom returns null for empty / invalid', () => {
    expect(parseHistoryFrom('')).toBeNull();
    expect(parseHistoryFrom(null)).toBeNull();
    expect(parseHistoryFrom('not-a-date')).toBeNull();
  });

  test('normalizeAsset uppercases and validates', () => {
    expect(normalizeAsset('xlm')).toBe('XLM');
    expect(normalizeAsset('USDC')).toBe('USDC');
    expect(normalizeAsset('BTC')).toBeNull();
    expect(normalizeAsset('')).toBeNull();
  });

  test('ALLOWED_HISTORY_ASSETS is non-empty', () => {
    expect(ALLOWED_HISTORY_ASSETS).toContain('XLM');
  });
});
