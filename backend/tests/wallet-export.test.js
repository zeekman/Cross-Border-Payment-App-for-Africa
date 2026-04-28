jest.mock('../src/db');
jest.mock('../src/services/stellar');
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));
jest.mock('../src/services/twofa');

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { decryptPrivateKey } = require('../src/services/stellar');
const audit = require('../src/services/audit');
const { verifyToken } = require('../src/services/twofa');
const { exportKey } = require('../src/controllers/walletController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENCRYPTION_KEY = 'test_key';
});

test('returns 400 when password is missing', async () => {
  const req = {
    user: { userId: 1 },
    body: { wallet_id: null },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test' }
  };
  const res = mockRes();

  await exportKey(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Password is required' });
});

test('returns 404 when user not found', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });

  const req = {
    user: { userId: 1 },
    body: { password: 'test', wallet_id: null },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test' }
  };
  const res = mockRes();

  await exportKey(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
});

test('returns 401 when password is incorrect', async () => {
  const hashedPassword = await bcrypt.hash('correct_password', 10);
  db.query.mockResolvedValueOnce({ rows: [{ password_hash: hashedPassword, totp_enabled: false }] });

  const req = {
    user: { userId: 1 },
    body: { password: 'wrong_password', wallet_id: null },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test' }
  };
  const res = mockRes();

  await exportKey(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Incorrect password' });
});

test('returns 403 when 2FA is enabled but totp_code is missing', async () => {
  const hashedPassword = await bcrypt.hash('test_password', 10);
  db.query.mockResolvedValueOnce({ rows: [{ password_hash: hashedPassword, totp_enabled: true, totp_secret: 'secret123' }] });

  const req = {
    user: { userId: 1 },
    body: { password: 'test_password', wallet_id: null },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test' }
  };
  const res = mockRes();

  await exportKey(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: '2FA verification required' });
});

test('returns 403 when 2FA is enabled but totp_code is invalid', async () => {
  const hashedPassword = await bcrypt.hash('test_password', 10);
  db.query.mockResolvedValueOnce({ rows: [{ password_hash: hashedPassword, totp_enabled: true, totp_secret: 'secret123' }] });
  verifyToken.mockReturnValue(false);

  const req = {
    user: { userId: 1 },
    body: { password: 'test_password', totp_code: '000000', wallet_id: null },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test' }
  };
  const res = mockRes();

  await exportKey(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: '2FA verification required' });
});

test('exports key successfully when 2FA is enabled and valid totp_code is provided', async () => {
  const hashedPassword = await bcrypt.hash('test_password', 10);
  db.query.mockResolvedValueOnce({ rows: [{ password_hash: hashedPassword, totp_enabled: true, totp_secret: 'secret123' }] });
  db.query.mockResolvedValueOnce({ rows: [{ id: 'wallet1', public_key: 'GPUB', encrypted_secret_key: 'enc_key', is_default: true }] });
  verifyToken.mockReturnValue(true);
  decryptPrivateKey.mockReturnValue('GPRIV');

  const req = {
    user: { userId: 1 },
    body: { password: 'test_password', totp_code: '123456', wallet_id: null },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test' }
  };
  const res = mockRes();

  await exportKey(req, res, jest.fn());

  expect(verifyToken).toHaveBeenCalledWith('secret123', '123456');
  expect(audit.log).toHaveBeenCalledWith(1, 'wallet_export', '127.0.0.1', 'test', { wallet_id: 'wallet1' });
  expect(res.json).toHaveBeenCalledWith({ secret_key: 'GPRIV' });
});

test('exports key successfully when 2FA is disabled (no totp_code required)', async () => {
  const hashedPassword = await bcrypt.hash('test_password', 10);
  db.query.mockResolvedValueOnce({ rows: [{ password_hash: hashedPassword, totp_enabled: false }] });
  db.query.mockResolvedValueOnce({ rows: [{ id: 'wallet1', public_key: 'GPUB', encrypted_secret_key: 'enc_key', is_default: true }] });
  decryptPrivateKey.mockReturnValue('GPRIV');

  const req = {
    user: { userId: 1 },
    body: { password: 'test_password', wallet_id: null },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test' }
  };
  const res = mockRes();

  await exportKey(req, res, jest.fn());

  expect(verifyToken).not.toHaveBeenCalled();
  expect(audit.log).toHaveBeenCalledWith(1, 'wallet_export', '127.0.0.1', 'test', { wallet_id: 'wallet1' });
  expect(res.json).toHaveBeenCalledWith({ secret_key: 'GPRIV' });
});
