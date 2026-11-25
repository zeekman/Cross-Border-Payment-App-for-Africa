jest.mock('../src/db');
jest.mock('../src/services/stellar');

const db = require('../src/db');
const { send } = require('../src/controllers/paymentController');

const WALLET = 'GABC1234PUBLICKEY';

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [{ public_key: WALLET, encrypted_secret_key: 'enc' }] });
});

test('returns 400 when recipient_address matches sender public_key', async () => {
  const req = {
    user: { userId: 1 },
    body: { recipient_address: WALLET, amount: '10', asset: 'XLM' }
  };
  const res = mockRes();

  await send(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Cannot send payment to your own wallet' });
});

test('does not block payment when recipient differs from sender', async () => {
  const { sendPayment } = require('../src/services/stellar');
  sendPayment.mockResolvedValue({ transactionHash: 'abc123', ledger: 1 });
  // wallet → velocity (count=0) → daily-limit (total=0) → INSERT
  db.query
    .mockResolvedValueOnce({ rows: [{ public_key: WALLET, encrypted_secret_key: 'enc' }] })
    .mockResolvedValueOnce({ rows: [{ count: '0' }] })
    .mockResolvedValueOnce({ rows: [{ total: '0' }] })
    .mockResolvedValueOnce({ rows: [] });

  const req = {
    user: { userId: 1 },
    body: { recipient_address: 'GDIFFERENTADDRESS', amount: '10', asset: 'XLM' }
  };
  const res = mockRes();

  await send(req, res, jest.fn());

  expect(res.status).not.toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Payment sent successfully' }));
});
