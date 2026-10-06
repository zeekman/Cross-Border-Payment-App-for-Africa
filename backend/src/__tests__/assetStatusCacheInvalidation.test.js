'use strict';

/**
 * BE-030: disabling a supported asset must invalidate the balance cache
 * immediately, rather than relying on the cache TTL to expire.
 */

jest.mock('../utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const dbMock = { query: jest.fn() };
jest.mock('../db', () => dbMock);

const delPatternMock = jest.fn();
jest.mock('../utils/cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  delPattern: (...args) => delPatternMock(...args),
  BALANCE_TTL: 30,
}));

const { setAssetStatus } = require('../controllers/assetController');

function mockRes() {
  return { json: jest.fn(), status: jest.fn().mockReturnThis() };
}

describe('setAssetStatus (BE-030 cache invalidation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('disabling an asset updates is_active and invalidates the balance cache', async () => {
    dbMock.query.mockResolvedValue({
      rows: [{ id: 2, asset_code: 'USDC', asset_issuer: 'GISSUER', is_active: false }],
    });

    const req = { params: { id: '2' }, body: { is_active: false }, user: { userId: 'admin-1' } };
    const res = mockRes();
    const next = jest.fn();

    await setAssetStatus(req, res, next);

    expect(dbMock.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE supported_assets'),
      [false, '2']
    );
    // The cache-invalidation path: every toggle must clear balance cache entries
    // immediately, not rely on TTL expiry (see doc comment in assetController.js).
    expect(delPatternMock).toHaveBeenCalledWith('balance:*');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      asset: { id: 2, asset_code: 'USDC', asset_issuer: 'GISSUER', is_active: false },
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('404s and does not touch the cache when the asset does not exist', async () => {
    dbMock.query.mockResolvedValue({ rows: [] });

    const req = { params: { id: '999' }, body: { is_active: false }, user: { userId: 'admin-1' } };
    const res = mockRes();
    const next = jest.fn();

    await setAssetStatus(req, res, next);

    expect(delPatternMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  test('rejects a non-boolean is_active without touching the DB or cache', async () => {
    const req = { params: { id: '2' }, body: { is_active: 'nope' }, user: { userId: 'admin-1' } };
    const res = mockRes();
    const next = jest.fn();

    await setAssetStatus(req, res, next);

    expect(dbMock.query).not.toHaveBeenCalled();
    expect(delPatternMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});
