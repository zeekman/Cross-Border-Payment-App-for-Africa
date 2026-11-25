jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../services/stellar', () => ({
  sendPayment: jest.fn(),
  sendPathPayment: jest.fn(),
  sendStrictReceivePathPayment: jest.fn(),
  getBalance: jest.fn(),
}));
jest.mock('../services/fees', () => ({
  buildFeeBreakdown: jest.fn(async (gross, asset) => {
    const amount = Number(gross);
    const fee = Number((amount * 500 / 10000).toFixed(7));
    const net = Number((amount - fee).toFixed(7));
    return {
      gross_amount: amount,
      platform_fee_bps: 500,
      platform_fee_amount: fee,
      net_amount: net,
      gross_amount_usdc: amount,
      platform_fee_usdc: fee,
      net_amount_usdc: net,
      stellar_base_fee_xlm: null,
      asset,
    };
  }),
  withStellarFee: jest.fn((breakdown, feeCharged) => Object.assign({}, breakdown, {
    stellar_base_fee_xlm: feeCharged == null ? null : Number((Number(feeCharged) / 1e7).toFixed(7)),
  })),
  collectPlatformFee: jest.fn(),
}));
jest.mock('../utils/cache', () => ({
  get: jest.fn().mockResolvedValue([{ asset: 'XLM', balance: '1000', available_balance: '1000' }]),
  set: jest.fn(),
  del: jest.fn(),
}));
jest.mock('../services/fraudDetection', () => ({
  checkVelocity: jest.fn().mockResolvedValue(false),
  checkDailyLimit: jest.fn().mockResolvedValue(false),
  checkFraud: jest.fn().mockResolvedValue({ blocked: false }),
  logFraudBlock: jest.fn(),
}));
jest.mock('../utils/distributedLock', () => ({
  withLock: jest.fn(async (_key, _ttl, callback) => {
    await callback();
    return true;
  }),
}));
jest.mock('../services/memoRequired', () => ({ isMemoRequired: jest.fn().mockResolvedValue(false) }));
jest.mock('../controllers/kycController', () => ({ amlRescreenForPayment: jest.fn() }));
jest.mock('../services/webhook', () => ({ deliver: jest.fn().mockResolvedValue(undefined) }));

const db = require('../db');
const { sendPayment, sendPathPayment, sendStrictReceivePathPayment } = require('../services/stellar');
const { buildFeeBreakdown, collectPlatformFee } = require('../services/fees');
const { send, sendPath, sendStrictReceivePath } = require('../controllers/paymentController');

const SENDER = 'G'.padEnd(56, 'A');
const RECIPIENT = 'G'.padEnd(55, 'B');

function makeResponse() {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
  db.query.mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'encrypted' }] });
  sendPathPayment.mockResolvedValue({ transactionHash: 'path-hash', ledger: 10, successful: true });
  sendStrictReceivePathPayment.mockResolvedValue({ transactionHash: 'strict-hash', ledger: 11, successful: true });
  sendPayment.mockResolvedValue({ transactionHash: 'send-hash' });
});

test('send applies the configured fee and persists it for analytics', async () => {
  const req = {
    user: { userId: 'user-1' },
    requestId: 'request-send',
    body: { recipient_address: RECIPIENT, amount: '20', asset: 'XLM' },
  };
  const response = makeResponse();

  await send(req, response, jest.fn());

  expect(sendPayment.mock.calls[0][0]).toMatchObject({ amount: '19' });
  const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO transactions'));
  expect(insert[1][3]).toBe('20');
  expect(insert[1][15]).toBe(1);
  expect(JSON.parse(insert[1][14])).toMatchObject({ gross_amount: 20, net_amount: 19 });
});

test('send-path reduces the source amount and persists its fee breakdown', async () => {
  const req = {
    user: { userId: 'user-1' },
    requestId: 'request-1',
    body: {
      recipient_address: RECIPIENT,
      source_asset: 'XLM',
      source_amount: '20',
      destination_asset: 'USDC',
      destination_min_amount: '1',
    },
  };
  const response = makeResponse();

  await sendPath(req, response, jest.fn());

  expect(sendPathPayment.mock.calls[0][0]).toMatchObject({ sourceAmount: 19 });
  expect(buildFeeBreakdown).toHaveBeenCalledWith('20', 'XLM');
  expect(collectPlatformFee).toHaveBeenCalledWith(expect.objectContaining({ platform_fee_amount: 1 }), SENDER);
  const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO transactions'));
  expect(insert[1][3]).toBe('20');
  expect(insert[1][13]).toBe(1);
  expect(JSON.parse(insert[1][14])).toMatchObject({ gross_amount: 20, net_amount: 19 });
});

test('strict-receive reduces the destination amount and persists its fee breakdown', async () => {
  const req = {
    user: { userId: 'user-1' },
    requestId: 'request-2',
    body: {
      recipient_address: RECIPIENT,
      source_asset: 'XLM',
      source_max_amount: '20',
      destination_asset: 'USDC',
      destination_amount: '10',
    },
  };
  const response = makeResponse();

  await sendStrictReceivePath(req, response, jest.fn());

  expect(sendStrictReceivePathPayment.mock.calls[0][0]).toMatchObject({ destinationAmount: 9.5 });
  expect(buildFeeBreakdown).toHaveBeenCalledWith('10', 'USDC');
  expect(collectPlatformFee).toHaveBeenCalledWith(expect.objectContaining({ platform_fee_amount: 0.5 }), SENDER);
  const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO transactions'));
  expect(insert[1][3]).toBe('10');
  expect(insert[1][13]).toBe(0.5);
  expect(JSON.parse(insert[1][14])).toMatchObject({ gross_amount: 10, net_amount: 9.5 });
});
