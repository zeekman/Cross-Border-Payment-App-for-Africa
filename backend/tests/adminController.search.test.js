const db = require('../src/db');
const { getUsers } = require('../src/controllers/adminController');

jest.mock('../src/db');
jest.mock('../src/services/stellar', () => ({
  getStellarStats: jest.fn(),
  getAccountFlags: jest.fn(),
  setAccountFlags: jest.fn(),
  clawbackAsset: jest.fn()
}));

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Admin Controller - getUsers', () => {
  it('should return 400 if search string exceeds 100 characters', async () => {
    const req = {
      query: {
        search: 'a'.repeat(101)
      }
    };
    const res = mockRes();
    const next = jest.fn();

    await getUsers(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Search string exceeds maximum length of 100 characters' });
  });

  it('should escape PostgreSQL special characters in search string', async () => {
    const req = {
      query: {
        search: '100%_sure\\'
      }
    };
    const res = mockRes();
    const next = jest.fn();

    db.query.mockResolvedValue({ rows: [], count: 0 });
    // Mock the count query too
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await getUsers(req, res, next);

    expect(db.query).toHaveBeenCalledTimes(2);
    
    // Check that the parameter used for search has the escaped characters
    const firstCallParams = db.query.mock.calls[0][1];
    expect(firstCallParams[0]).toBe('%100\\%\\_sure\\\\%');
    expect(firstCallParams[1]).toBe('%100\\%\\_sure\\\\%');
  });

  it('should verify that a search for "%" does not return all users', async () => {
    const req = {
      query: {
        search: '%'
      }
    };
    const res = mockRes();
    const next = jest.fn();

    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await getUsers(req, res, next);

    expect(db.query).toHaveBeenCalledTimes(2);
    
    // The search term should be escaped
    const firstCallParams = db.query.mock.calls[0][1];
    expect(firstCallParams[0]).toBe('%\\%%');
  });
});
