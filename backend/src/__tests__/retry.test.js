const { withRetry } = require('../utils/retry');

// Silence logger output during tests
jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

// Speed up delays
jest.useFakeTimers();

function horizonError(status) {
  const err = new Error(`Horizon ${status}`);
  err.response = { status };
  return err;
}

function networkError() {
  return new Error('ECONNRESET');
}

async function runWithTimers(promise) {
  // Advance all pending timers until the promise resolves
  const result = promise;
  await Promise.resolve(); // flush microtasks
  jest.runAllTimersAsync();
  return result;
}

describe('withRetry', () => {
  beforeEach(() => jest.clearAllMocks());

  test('resolves immediately on success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on 503 and succeeds on second attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(horizonError(503))
      .mockResolvedValue('ok');

    const promise = withRetry(fn);
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries on 504', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(horizonError(504))
      .mockResolvedValue('done');

    const promise = withRetry(fn);
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries on network error (no status)', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue('done');

    const promise = withRetry(fn);
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('exhausts all retries and throws after maxAttempts', async () => {
    jest.useRealTimers();
    const fn = jest.fn().mockRejectedValue(horizonError(503));

    // Use maxAttempts=1 so no delay is needed
    await expect(withRetry(fn, { maxAttempts: 1 })).rejects.toThrow('Horizon 503');
    expect(fn).toHaveBeenCalledTimes(1);
    jest.useFakeTimers();
  });

  test('does NOT retry on 400', async () => {
    const fn = jest.fn().mockRejectedValue(horizonError(400));
    await expect(withRetry(fn)).rejects.toMatchObject({ message: 'Horizon 400' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('does NOT retry on 401', async () => {
    const fn = jest.fn().mockRejectedValue(horizonError(401));
    await expect(withRetry(fn)).rejects.toMatchObject({ message: 'Horizon 401' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('logs each retry attempt', async () => {
    const logger = require('../utils/logger');
    const fn = jest.fn()
      .mockRejectedValueOnce(horizonError(503))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { label: 'submitTransaction' });
    await jest.runAllTimersAsync();
    await promise;

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('submitTransaction'),
      expect.objectContaining({ status: 503 })
    );
  });

  test('delay is capped at 10 seconds', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    const fn = jest.fn()
      .mockRejectedValueOnce(horizonError(503))
      .mockRejectedValueOnce(horizonError(503))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxAttempts: 4 });
    await jest.runAllTimersAsync();
    await promise;

    const delays = spy.mock.calls.map(([, ms]) => ms);
    expect(delays.every(d => d <= 10_000)).toBe(true);
    spy.mockRestore();
  });
});
