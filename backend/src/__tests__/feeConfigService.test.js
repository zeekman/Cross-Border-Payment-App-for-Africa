'use strict';

jest.mock('../db');
jest.mock('../utils/cache');
jest.mock('../services/audit');

const db = require('../db');
const cache = require('../utils/cache');
const feeConfigService = require('../services/feeConfigService');

function mockRedisClient() {
  const redis = { keys: jest.fn() };
  cache.getClient.mockReturnValue(redis);
  return redis;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('refreshCache', () => {
  test('completes without throwing when active fee configs exist', async () => {
    db.query.mockResolvedValue({
      rows: [
        { fee_type: 'send', asset_code: 'USDC', fee_bps: 100, max_fee_usdc: 10, min_fee_usdc: 1, effective_from: new Date() },
        { fee_type: 'send', asset_code: 'XLM', fee_bps: 50, max_fee_usdc: 5, min_fee_usdc: 0.5, effective_from: new Date() },
      ],
    });
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue(undefined);
    cache.del.mockResolvedValue(undefined);
    const redis = mockRedisClient();
    redis.keys.mockResolvedValue([
      'fee_config:active:send:USDC',
      'fee_config:active:send:XLM',
      'fee_config:active:withdraw:USDC',
    ]);
    cache.getClient.mockReturnValue(redis);

    await expect(feeConfigService.refreshCache()).resolves.not.toThrow();
  });

  test('does not throw when no active fee configs exist', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const redis = mockRedisClient();
    redis.keys.mockResolvedValue([]);
    cache.getClient.mockReturnValue(redis);

    await expect(feeConfigService.refreshCache()).resolves.not.toThrow();
  });

  test('deletes stale Redis keys for previously active fee types', async () => {
    db.query.mockResolvedValue({
      rows: [
        { fee_type: 'send', asset_code: 'USDC', fee_bps: 100, max_fee_usdc: 10, min_fee_usdc: 1, effective_from: new Date() },
      ],
    });
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue(undefined);
    cache.del.mockResolvedValue(undefined);
    const redis = mockRedisClient();
    redis.keys.mockResolvedValue([
      'fee_config:active:send:USDC',
      'fee_config:active:withdraw:USDC',
      'fee_config:active:send:XLM',
    ]);
    cache.getClient.mockReturnValue(redis);

    await feeConfigService.refreshCache();

    // send:USDC should be set (active), withdraw:USDC and send:XLM should be deleted (stale)
    expect(cache.set).toHaveBeenCalledWith(
      'fee_config:active:send:USDC',
      expect.objectContaining({ fee_type: 'send', asset_code: 'USDC' }),
      expect.any(Number)
    );
    expect(cache.del).toHaveBeenCalledWith('fee_config:active:withdraw:USDC');
    expect(cache.del).toHaveBeenCalledWith('fee_config:active:send:XLM');
  });

  test('createConfig calls refreshCache without throwing', async () => {
    db.pool.connect.mockResolvedValue({
      query: jest.fn()
        .mockResolvedValueOnce() // BEGIN
        .mockResolvedValueOnce() // UPDATE
        .mockResolvedValueOnce({ rows: [{ id: 1, fee_type: 'send', asset_code: 'USDC', fee_bps: 100, max_fee_usdc: 10, min_fee_usdc: 1, is_active: true, created_by: 'admin', effective_from: new Date() }] }) // INSERT RETURNING
        .mockResolvedValueOnce(), // COMMIT
      release: jest.fn(),
    });
    db.query.mockResolvedValue({ rows: [] });
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue(undefined);
    cache.del.mockResolvedValue(undefined);
    const redis = mockRedisClient();
    redis.keys.mockResolvedValue([]);
    cache.getClient.mockReturnValue(redis);

    await expect(
      feeConfigService.createConfig('send', 'USDC', 100, 10, 1, new Date(), 'admin', 'admin', '127.0.0.1', 'test-agent')
    ).resolves.not.toThrow();
  });

  test('patchConfig calls refreshCache without throwing', async () => {
    const existing = {
      id: 1, fee_type: 'send', asset_code: 'USDC', fee_bps: 100, max_fee_usdc: 10, min_fee_usdc: 1,
      is_active: true, created_by: 'admin', effective_from: new Date(),
    };
    db.query.mockResolvedValue({ rows: [existing] });
    db.pool.connect.mockResolvedValue({
      query: jest.fn()
        .mockResolvedValueOnce() // BEGIN
        .mockResolvedValueOnce() // UPDATE deactivate same type
        .mockResolvedValueOnce() // UPDATE deactivate self
        .mockResolvedValueOnce({ rows: [{ id: 2, fee_type: 'send', asset_code: 'USDC', fee_bps: 150, max_fee_usdc: 15, min_fee_usdc: 1, is_active: true, created_by: 'admin', effective_from: new Date() }] }) // INSERT RETURNING
        .mockResolvedValueOnce(), // COMMIT
      release: jest.fn(),
    });
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue(undefined);
    cache.del.mockResolvedValue(undefined);
    const redis = mockRedisClient();
    redis.keys.mockResolvedValue([]);
    cache.getClient.mockReturnValue(redis);

    await expect(
      feeConfigService.patchConfig(1, { fee_bps: 150 }, 'admin', 'admin', '127.0.0.1', 'test-agent')
    ).resolves.not.toThrow();
  });
});
