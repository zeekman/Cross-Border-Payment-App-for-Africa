const jwt = require('jsonwebtoken');

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../controllers/sessionController', () => ({ isJtiBlacklisted: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/audit', () => ({ auditLog: jest.fn() }));

const db = require('../db');
const audit = require('../services/audit');
const authMiddleware = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('auth middleware DB-backed role (#1303)', () => {
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });

  it('denies admin access once the DB role is demoted, even with an unexpired admin token', async () => {
    const token = jwt.sign({ userId: 'u1', role: 'admin' }, 'test-secret', { expiresIn: '15m' });
    db.query.mockResolvedValueOnce({ rows: [{ is_suspended: false, role: 'user' }] });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.role).toBe('user');
    expect(audit.auditLog).toHaveBeenCalledWith(expect.anything(), 'role_change_detected', expect.any(Object));

    const adminNext = jest.fn();
    isAdmin(req, res, adminNext);
    expect(adminNext).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
