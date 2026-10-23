jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/stellar', () => ({ verifyIncomingPayment: jest.fn() }));

const db = require('../src/db');
const { listMine, cancel } = require('../src/controllers/paymentRequestController');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => db.query.mockReset());

describe('payment request ownership', () => {
  test('listMine scopes the query to the authenticated user', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'r1', status: 'pending' }] });
    const res = mockRes();
    await listMine({ user: { userId: 'u1' }, query: {} }, res, jest.fn());
    expect(db.query.mock.calls[0][1][0]).toBe('u1');
    expect(db.query.mock.calls[1][1][0]).toBe('u1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ total: 1 }));
  });

  test('listMine rejects an invalid status filter', async () => {
    const res = mockRes();
    await listMine({ user: { userId: 'u1' }, query: { status: 'bogus' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('cancel returns 404 for another user\'s request', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ requester_id: 'other', claimed: false }] });
    const res = mockRes();
    await cancel({ user: { userId: 'u1' }, params: { id: 'r1' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('cancel refuses a paid request', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ requester_id: 'u1', claimed: true }] });
    const res = mockRes();
    await cancel({ user: { userId: 'u1' }, params: { id: 'r1' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('cancel marks the owner\'s pending request cancelled', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ requester_id: 'u1', claimed: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = mockRes();
    await cancel({ user: { userId: 'u1' }, params: { id: 'r1' } }, res, jest.fn());
    expect(db.query.mock.calls[1][0]).toMatch(/cancelled/);
    expect(res.json).toHaveBeenCalledWith({ message: 'Payment request cancelled' });
  });
});
