/**
 * Unit tests for the memoRequired service.
 * These run against the real implementation (no mock of memoRequired itself).
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('../utils/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
}));

// ---------------------------------------------------------------------------
// isMemoRequired unit tests
// ---------------------------------------------------------------------------

// Valid Stellar Ed25519 public keys
const MEMO_REQUIRED_ADDRESS = 'GCDENRHBHC6YNAVKWHGYREZXWURXQYSZRXBBLOHUFAV4RHOHSGVLGMMG';
const REGULAR_ADDRESS       = 'GDS3MNUP3WNLOU2VE5GKWSQFUW55L7P3HFS3EXEZEXMW4RVJUFFOAKLQ';

describe('memoRequired service', () => {
  let cacheModule;

  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    // Re-require cache mock after resetModules so references stay fresh
    cacheModule = require('../utils/cache');
    cacheModule.get.mockResolvedValue(null);  // default: cache miss
    cacheModule.set.mockResolvedValue(undefined);
  });

  function mockDirectory(addresses) {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        _embedded: {
          records: addresses.map(a => ({ address: a, tags: ['memo_required'] })),
        },
      }),
    });
  }

  test('returns true for a known memo-required address', async () => {
    mockDirectory([MEMO_REQUIRED_ADDRESS]);
    const { isMemoRequired } = require('../services/memoRequired');
    await expect(isMemoRequired(MEMO_REQUIRED_ADDRESS)).resolves.toBe(true);
  });

  test('returns false for a regular address', async () => {
    mockDirectory([MEMO_REQUIRED_ADDRESS]);
    const { isMemoRequired } = require('../services/memoRequired');
    await expect(isMemoRequired(REGULAR_ADDRESS)).resolves.toBe(false);
  });

  test('fails open when directory fetch fails (does not throw)', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));
    const { isMemoRequired } = require('../services/memoRequired');
    await expect(isMemoRequired(MEMO_REQUIRED_ADDRESS)).resolves.toBe(false);
  });

  // ── Issue #281: per-address caching ──────────────────────────────────────

  test('stores result in cache after first call', async () => {
    mockDirectory([MEMO_REQUIRED_ADDRESS]);
    const { isMemoRequired } = require('../services/memoRequired');

    await isMemoRequired(MEMO_REQUIRED_ADDRESS);

    expect(cacheModule.set).toHaveBeenCalledWith(
      `memo_required:${MEMO_REQUIRED_ADDRESS}`,
      { required: true },
      600 // 10 minutes in seconds
    );
  });

  test('uses cache on second call for the same address — no extra fetch', async () => {
    // First call: cache miss, fetch directory
    mockDirectory([MEMO_REQUIRED_ADDRESS]);
    cacheModule.get
      .mockResolvedValueOnce(null)                    // first call: miss
      .mockResolvedValueOnce({ required: true });     // second call: hit

    const { isMemoRequired } = require('../services/memoRequired');

    const first  = await isMemoRequired(MEMO_REQUIRED_ADDRESS);
    const second = await isMemoRequired(MEMO_REQUIRED_ADDRESS);

    expect(first).toBe(true);
    expect(second).toBe(true);
    // fetch should only have been called once (for the directory on the first call)
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('cache key is memo_required:{address}', async () => {
    mockDirectory([]);
    const { isMemoRequired } = require('../services/memoRequired');

    await isMemoRequired(REGULAR_ADDRESS);

    expect(cacheModule.get).toHaveBeenCalledWith(`memo_required:${REGULAR_ADDRESS}`);
  });
});
