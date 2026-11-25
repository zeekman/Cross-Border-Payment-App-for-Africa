jest.mock('../services/feeConfigService', () => ({
  getActiveConfig: jest.fn(),
}));
jest.mock('../services/feeDistributor', () => ({
  depositFee: jest.fn().mockResolvedValue('fee-deposit-hash'),
}));
jest.mock('../services/stellar', () => ({
  getAssetContractAddress: jest.fn((asset) => `contract-${asset}`),
}));

const { getActiveConfig } = require('../services/feeConfigService');
const { depositFee } = require('../services/feeDistributor');
const { buildFeeBreakdown, collectPlatformFee, withStellarFee } = require('../services/fees');

beforeEach(() => jest.clearAllMocks());

test('uses the active fee config for the asset', async () => {
  getActiveConfig.mockResolvedValue({ fee_bps: 400, min_fee_usdc: 2, max_fee_usdc: 3 });

  const breakdown = await buildFeeBreakdown('25', 'USDC');

  expect(getActiveConfig).toHaveBeenCalledWith('platform', 'USDC');
  expect(breakdown).toMatchObject({
    gross_amount: 25,
    platform_fee_bps: 400,
    platform_fee_amount: 2,
    net_amount: 23,
  });
});

test('adds the Stellar network fee without recalculating the platform fee', () => {
  const breakdown = withStellarFee({ platform_fee_amount: 2, net_amount: 23 }, '100');

  expect(breakdown).toEqual({ platform_fee_amount: 2, net_amount: 23, stellar_base_fee_xlm: 0.00001 });
});

test('collects the calculated fee through the fee distributor', async () => {
  await collectPlatformFee({ asset: 'USDC', platform_fee_amount: 1.25 }, 'sender');

  expect(depositFee).toHaveBeenCalledWith(12_500_000, 'contract-USDC', 'sender');
});
