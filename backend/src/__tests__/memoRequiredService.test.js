/**
 * Unit tests for the memoRequired service.
 * These run against the real implementation (no mock of memoRequired itself).
 */

// ---------------------------------------------------------------------------
// isMemoRequired unit tests
// ---------------------------------------------------------------------------

// Valid Stellar Ed25519 public keys
const MEMO_REQUIRED_ADDRESS = 'GCDENRHBHC6YNAVKWHGYREZXWURXQYSZRXBBLOHUFAV4RHOHSGVLGMMG';
const REGULAR_ADDRESS       = 'GDS3MNUP3WNLOU2VE5GKWSQFUW55L7P3HFS3EXEZEXMW4RVJUFFOAKLQ';

describe('memoRequired service', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
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
});
