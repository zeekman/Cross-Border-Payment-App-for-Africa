const { withTimeout } = require('../src/utils/withTimeout');

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('resolves when promise settles before deadline', async () => {
    const p = withTimeout(Promise.resolve('ok'), 1000);
    const result = await p;
    expect(result).toBe('ok');
  });

  test('rejects with ETIMEDOUT when promise hangs', async () => {
    const p = withTimeout(new Promise(() => {}), 50);
    const assert = expect(p).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    jest.advanceTimersByTime(50);
    await assert;
  });
});
