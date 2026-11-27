'use strict';

jest.mock('../db');

const db = require('../db');
const corridorConfigService = require('../services/corridorConfigService');

beforeEach(() => jest.clearAllMocks());

test('looks up corridor policies using normalized country codes', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ origin_country: 'NG', destination_country: 'GH' }] });

  await corridorConfigService.getCorridorConfig('ng', 'gh');

  expect(db.query).toHaveBeenCalledWith(
    expect.stringContaining('FROM corridor_configs'),
    ['NG', 'GH']
  );
});

test('rejects invalid corridor tiers before writing configuration', async () => {
  await expect(corridorConfigService.upsertCorridorConfig({
    origin_country: 'NG',
    destination_country: 'GH',
    required_kyc_tier: 'tier-4',
    allowed_assets: ['USDC'],
  }, 'admin-1')).rejects.toMatchObject({ status: 400 });
  expect(db.query).not.toHaveBeenCalled();
});
