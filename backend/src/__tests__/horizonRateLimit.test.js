/**
 * Tests for horizonRateLimit.js
 * Covers: 429 retry with Retry-After, max retries exceeded, request counting, 80% warning.
 */

jest.useFakeTimers();

// Fresh module for each test to reset in-memory state
let horizonRateLimit;

beforeEach(() => {
  jest.resetModules();
  horizonRateLimit = require('../services/horizonRateLimit');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.clearAllTimers();
  console.warn.mockRestore();
});

// ---------------------------------------------------------------------------
// withRetry — success on first attempt
// ---------------------------------------------------------------------------
test('withRetry resolves immediately on success', async () => {
  const fn = jest.fn().mockResolvedValue('ok');
  const result = await horizonRateLimit.withRetry(fn);
  expect(result).toBe('ok');
  expect(fn).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// withRetry — retries on 429 and succeeds
// ---------------------------------------------------------------------------
test('withRetry retries after 429 and returns result on success', async () => {
  const err429 = { response: { status: 429, headers: { 'retry-after': '1' } } };
  const fn = jest.fn()
    .mockRejectedValueOnce(err429)
    .mockResolvedValueOnce('retried-ok');

  const promise = horizonRateLimit.withRetry(fn);
  // Advance past the 1s Retry-After wait
  await Promise.resolve(); // let first attempt reject
  jest.advanceTimersByTime(1100);
  const result = await promise;

  expect(result).toBe('retried-ok');
  expect(fn).toHaveBeenCalledTimes(2);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('429'));
});

// ---------------------------------------------------------------------------
// withRetry — exhausts retries and re-throws
// ---------------------------------------------------------------------------
test('withRetry throws after maxRetries 429s', async () => {
  const err429 = { response: { status: 429, headers: { 'retry-after': '1' } } };
  const fn = jest.fn().mockRejectedValue(err429);

  const promise = horizonRateLimit.withRetry(fn, 2);

  // Drain microtasks + advance timers for each retry (initial + 2 retries = 3 calls)
  for (let i = 0; i < 2; i++) {
    await Promise.resolve(); // let rejection propagate
    jest.advanceTimersByTime(1100);
    await Promise.resolve(); // let setTimeout callback fire
  }

  await expect(promise).rejects.toEqual(err429);
  expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
}, 10000);

// ---------------------------------------------------------------------------
// withRetry — non-429 errors are not retried
// ---------------------------------------------------------------------------
test('withRetry does not retry non-429 errors', async () => {
  const err500 = { response: { status: 500 } };
  const fn = jest.fn().mockRejectedValue(err500);

  await expect(horizonRateLimit.withRetry(fn)).rejects.toEqual(err500);
  expect(fn).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// withRetry — missing Retry-After header defaults to 5s
// ---------------------------------------------------------------------------
test('withRetry defaults to 5s wait when Retry-After header is absent', async () => {
  const err429 = { response: { status: 429, headers: {} } };
  const fn = jest.fn()
    .mockRejectedValueOnce(err429)
    .mockResolvedValueOnce('ok');

  const promise = horizonRateLimit.withRetry(fn);
  await Promise.resolve();
  jest.advanceTimersByTime(5100);
  await promise;

  expect(fn).toHaveBeenCalledTimes(2);
});

// ---------------------------------------------------------------------------
// getStatus — reflects recorded requests
// ---------------------------------------------------------------------------
test('getStatus returns correct used/remaining counts', async () => {
  const fn = jest.fn().mockResolvedValue('x');
  await horizonRateLimit.withRetry(fn);
  await horizonRateLimit.withRetry(fn);

  const status = horizonRateLimit.getStatus();
  expect(status.used).toBe(2);
  expect(status.limit).toBe(3600);
  expect(status.remaining).toBe(3598);
});

// ---------------------------------------------------------------------------
// 80% warning log
// ---------------------------------------------------------------------------
test('logs warning when requests reach 80% of limit', () => {
  const LIMIT = 3600;
  const threshold = Math.ceil(LIMIT * 0.8); // 2880

  // Directly call recordRequest to avoid slow async loop
  for (let i = 0; i < threshold; i++) {
    horizonRateLimit.recordRequest();
  }

  expect(console.warn).toHaveBeenCalledWith(
    expect.stringContaining('Rate limit warning')
  );
});
