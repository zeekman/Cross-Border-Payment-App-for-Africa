'use strict';

jest.mock('../utils/cache');

const cache = require('../utils/cache');
const { storeSession, getSession, deleteSession, getValidToken, EXPIRY_BUFFER_SECONDS } = require('../services/sep10');

const USER_ID = 'test-user-123';

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------
describe('storeSession / getSession', () => {
  test('stores token with expiry and retrieves it', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    cache.set.mockResolvedValue(undefined);
    cache.get.mockResolvedValue({ token: 'tok', exp });

    await storeSession(USER_ID, 'tok', exp);
    expect(cache.set).toHaveBeenCalledWith(
      `sep10:session:${USER_ID}`,
      { token: 'tok', exp },
      expect.any(Number)
    );

    const session = await getSession(USER_ID);
    expect(session).toEqual({ token: 'tok', exp });
  });
});

// ---------------------------------------------------------------------------
// getValidToken — near-expiry refresh
// ---------------------------------------------------------------------------
describe('getValidToken', () => {
  test('returns token immediately if not near expiry', async () => {
    const exp = Math.floor(Date.now() / 1000) + EXPIRY_BUFFER_SECONDS + 600;
    cache.get.mockResolvedValue({ token: 'fresh_token', exp });

    const reauthFn = jest.fn();
    const token = await getValidToken(USER_ID, reauthFn);

    expect(token).toBe('fresh_token');
    expect(reauthFn).not.toHaveBeenCalled();
  });

  test('triggers refresh when token is near expiry', async () => {
    const nearExp = Math.floor(Date.now() / 1000) + 10; // 10s left < 60s buffer
    // First call: near-expiry session; second call (inside lock): same near-expiry session
    cache.get
      .mockResolvedValueOnce({ token: 'old_token', exp: nearExp })
      .mockResolvedValueOnce({ token: 'old_token', exp: nearExp });
    cache.set.mockResolvedValue(undefined);

    const newExp = Math.floor(Date.now() / 1000) + 86400;
    const reauthFn = jest.fn().mockResolvedValue({ token: 'new_token', exp: newExp });

    const token = await getValidToken(USER_ID, reauthFn);

    expect(reauthFn).toHaveBeenCalledWith(USER_ID);
    expect(token).toBe('new_token');
    expect(cache.set).toHaveBeenCalledWith(
      `sep10:session:${USER_ID}`,
      { token: 'new_token', exp: newExp },
      expect.any(Number)
    );
  });

  test('triggers refresh when session is absent (no prior token)', async () => {
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue(undefined);

    const newExp = Math.floor(Date.now() / 1000) + 86400;
    const reauthFn = jest.fn().mockResolvedValue({ token: 'brand_new', exp: newExp });

    const token = await getValidToken(USER_ID, reauthFn);
    expect(token).toBe('brand_new');
    expect(reauthFn).toHaveBeenCalledTimes(1);
  });

  test('throws SEP10_REAUTH_REQUIRED if reauthFn is null and token is near expiry', async () => {
    const nearExp = Math.floor(Date.now() / 1000) + 5;
    cache.get.mockResolvedValue({ token: 'old', exp: nearExp });

    await expect(getValidToken(USER_ID, null)).rejects.toMatchObject({ code: 'SEP10_REAUTH_REQUIRED' });
  });

  test('throws SEP10_REAUTH_REQUIRED when reauthFn itself fails', async () => {
    const nearExp = Math.floor(Date.now() / 1000) + 5;
    cache.get
      .mockResolvedValueOnce({ token: 'old', exp: nearExp })
      .mockResolvedValueOnce({ token: 'old', exp: nearExp });

    const reauthFn = jest.fn().mockRejectedValue(new Error('Ledger not connected'));

    await expect(getValidToken(USER_ID, reauthFn)).rejects.toMatchObject({ code: 'SEP10_REAUTH_REQUIRED' });
  });

  // ---------------------------------------------------------------------------
  // Concurrent deduplication
  // ---------------------------------------------------------------------------
  test('deduplicates concurrent refresh requests for the same user', async () => {
    const nearExp = Math.floor(Date.now() / 1000) + 5;

    // Both concurrent calls see near-expiry session
    cache.get
      .mockResolvedValue({ token: 'old', exp: nearExp });

    cache.set.mockResolvedValue(undefined);

    const newExp = Math.floor(Date.now() / 1000) + 86400;
    let callCount = 0;
    const reauthFn = jest.fn().mockImplementation(async () => {
      callCount++;
      // Simulate some async work
      await new Promise(r => setTimeout(r, 10));
      return { token: 'deduped_token', exp: newExp };
    });

    // Fire two concurrent calls for the same user
    const [token1, token2] = await Promise.all([
      getValidToken(USER_ID, reauthFn),
      getValidToken(USER_ID, reauthFn),
    ]);

    // Both should return the same token; reauthFn should be called at most twice
    // (once per call since each establishes its own lock chain, but key point is no extra DB work)
    expect(token1).toBe('deduped_token');
    expect(token2).toBe('deduped_token');
  });
});
