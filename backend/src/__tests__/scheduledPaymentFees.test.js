jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../services/stellar', () => ({ sendPayment: jest.fn() }));
jest.mock('../services/fees', () => ({
  buildFeeBreakdown: jest.fn(async (gross, asset) => {
    const amount = Number(gross);
    const fee = Number((amount * 250 / 10000).toFixed(7));
    const net = Number((amount - fee).toFixed(7));
    return {
      gross_amount: amount,
      platform_fee_bps: 250,
      platform_fee_amount: fee,
      net_amount: net,
      gross_amount_usdc: amount,
      platform_fee_usdc: fee,
      net_amount_usdc: net,
      stellar_base_fee_xlm: null,
      asset,
    };
  }),
  collectPlatformFee: jest.fn(),
}));
jest.mock('../utils/distributedLock', () => ({
  withLock: jest.fn((_key, _ttl, callback) => callback()),
}));

const db = require('../db');
const { sendPayment } = require('../services/stellar');
const { buildFeeBreakdown, collectPlatformFee } = require('../services/fees');
const { processScheduledPayments } = require('../jobs/scheduledPaymentsJob');

beforeEach(() => {
  jest.clearAllMocks();
  db.query
    .mockResolvedValueOnce({ rows: [{ id: 'scheduled-1', sender_wallet: 'sender', recipient_wallet: 'recipient', amount: '100', asset: 'USDC', memo: null, frequency: 'once' }] })
    .mockResolvedValueOnce({ rows: [{ encrypted_secret_key: 'encrypted' }] })
    .mockResolvedValue({ rows: [] });
  sendPayment.mockResolvedValue({ transactionHash: 'scheduled-hash', ledger: 22 });
});

test('scheduled payments send net amount and persist the fee breakdown', async () => {
  await processScheduledPayments();

  expect(buildFeeBreakdown).toHaveBeenCalledWith('100', 'USDC');
  expect(sendPayment).toHaveBeenCalledWith(expect.objectContaining({ amount: 97.5 }));
  const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO transactions'));
  expect(insert[1]).toEqual(['sender', 'recipient', '100', 'USDC', null, 'scheduled-hash', 2.5, expect.any(String)]);
  expect(JSON.parse(insert[1][7])).toMatchObject({ gross_amount: 100, platform_fee_amount: 2.5, net_amount: 97.5 });
  expect(collectPlatformFee).toHaveBeenCalledWith(expect.objectContaining({ platform_fee_amount: 2.5 }), 'sender');
});
