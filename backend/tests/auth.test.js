jest.mock('../src/db');
jest.mock('../src/services/stellar');
jest.mock('../src/services/email');

const crypto = require('crypto');
const db = require('../src/db');
const { sendVerificationEmail } = require('../src/services/email');
const { createWallet } = require('../src/services/stellar');
const { register, login, refresh, logout, verifyEmail } = require('../src/controllers/authController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

const FAMILY_ID = 'fam-uuid-1234-5678-abcd-ef0123456789';

function makeActiveToken(overrides) {
  return Object.assign({
    id: 'rt-1', user_id: 'u-1',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    family_id: FAMILY_ID, revoked: false,
    email: 'a@b.com', role: 'user',
  }, overrides);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = 'test_secret';
  process.env.FRONTEND_URL = 'http://localhost:3000';
  createWallet.mockResolvedValue({ publicKey: 'GPUBKEY', encryptedSecretKey: 'enc' });
  sendVerificationEmail.mockResolvedValue();
});

test('register: returns 409 if email already exists', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ id: '1' }] });
  const res = mockRes();
  await register({ body: { full_name: 'Alice', email: 'a@b.com', password: 'password1' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith({ error: 'Email already registered' });
});

test('register: creates user and sends verification email', async () => {
  db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await register({ body: { full_name: 'Alice', email: 'a@b.com', password: 'password1' } }, res, jest.fn());
  expect(sendVerificationEmail).toHaveBeenCalledWith('a@b.com', expect.any(String));
  expect(res.status).toHaveBeenCalledWith(201);
});

test('register: does NOT return a JWT token', async () => {
  db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await register({ body: { full_name: 'Alice', email: 'a@b.com', password: 'password1' } }, res, jest.fn());
  expect(res.json.mock.calls[0][0].token).toBeUndefined();
});

test('login: returns 401 for wrong password', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('correctpass', 12);
  db.query.mockResolvedValueOnce({ rows: [{ id: '1', full_name: 'Alice', email: 'a@b.com', password_hash: hash, email_verified: true, public_key: 'GPUB' }] });
  const res = mockRes();
  await login({ body: { email: 'a@b.com', password: 'wrongpass' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
});

test('login: returns 403 when email not verified', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query.mockResolvedValueOnce({ rows: [{ id: '1', full_name: 'Alice', email: 'a@b.com', password_hash: hash, email_verified: false, public_key: 'GPUB' }] });
  const res = mockRes();
  await login({ body: { email: 'a@b.com', password: 'password1' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(403);
});

test('login: returns JWT and sets HttpOnly cookie on success', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query.mockResolvedValueOnce({ rows: [{ id: '1', full_name: 'Alice', email: 'a@b.com', password_hash: hash, email_verified: true, public_key: 'GPUB' }] })
    .mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await login({ body: { email: 'a@b.com', password: 'password1' } }, res, jest.fn());
  expect(res.json.mock.calls[0][0].token).toBeDefined();
  expect(res.cookie).toHaveBeenCalledWith('refreshToken', expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: 'strict' }));
});

test('login: stores hashed refresh token in DB, not the raw value', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query.mockResolvedValueOnce({ rows: [{ id: '1', full_name: 'Alice', email: 'a@b.com', password_hash: hash, email_verified: true, public_key: 'GPUB' }] })
    .mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await login({ body: { email: 'a@b.com', password: 'password1' } }, res, jest.fn());
  const rawToken = res.cookie.mock.calls[0][1];
  const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_tokens'));
  expect(insertCall).toBeDefined();
  expect(insertCall[1][2]).toBe(crypto.createHash('sha256').update(rawToken).digest('hex'));
});

test('login: seeds a family_id when issuing the first refresh token', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query.mockResolvedValueOnce({ rows: [{ id: '1', full_name: 'Alice', email: 'a@b.com', password_hash: hash, email_verified: true, public_key: 'GPUB' }] })
    .mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await login({ body: { email: 'a@b.com', password: 'password1' } }, res, jest.fn());
  const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_tokens'));
  expect(insertCall).toBeDefined();
  expect(insertCall[1][3]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('refresh: returns 401 when no cookie present', async () => {
  const res = mockRes();
  await refresh({ cookies: {} }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'No refresh token' });
});

test('refresh: returns 401 for unknown token', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await refresh({ cookies: { refreshToken: 'unknownrawtoken' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid refresh token' });
});

test('refresh: returns 401 and clears cookie for expired token', async () => {
  db.query.mockResolvedValueOnce({ rows: [makeActiveToken({ expires_at: new Date(Date.now() - 1000).toISOString() })] })
    .mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await refresh({ cookies: { refreshToken: 'expiredrawtoken' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Refresh token expired' });
  expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', expect.any(Object));
});

test('refresh: rotates token  marks old revoked and inserts new one', async () => {
  db.query.mockResolvedValueOnce({ rows: [makeActiveToken()] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await refresh({ cookies: { refreshToken: 'validrawtoken' } }, res, jest.fn());
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: expect.any(String) }));
  expect(res.cookie).toHaveBeenCalledWith('refreshToken', expect.any(String), expect.objectContaining({ httpOnly: true }));
  expect(db.query.mock.calls.find(([sql]) => sql.includes('UPDATE refresh_tokens') && sql.includes('revoked'))).toBeDefined();
  expect(db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_tokens'))).toBeDefined();
});

test('refresh: new token carries the same family_id as the old one', async () => {
  db.query.mockResolvedValueOnce({ rows: [makeActiveToken()] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await refresh({ cookies: { refreshToken: 'validrawtoken' } }, res, jest.fn());
  const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_tokens'));
  expect(insertCall[1][3]).toBe(FAMILY_ID);
});

test('refresh: new cookie token differs from old one (rotation)', async () => {
  db.query.mockResolvedValueOnce({ rows: [makeActiveToken()] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await refresh({ cookies: { refreshToken: 'oldrawtoken12345' } }, res, jest.fn());
  expect(res.cookie.mock.calls[0][1]).not.toBe('oldrawtoken12345');
});

test('refresh: detects reuse  revoked token invalidates entire family', async () => {
  db.query.mockResolvedValueOnce({ rows: [makeActiveToken({ revoked: true })] })
    .mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await refresh({ cookies: { refreshToken: 'rotatedtoken' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/reuse detected/i) }));
  expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', expect.any(Object));
  const deleteCall = db.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM refresh_tokens') && sql.includes('family_id'));
  expect(deleteCall).toBeDefined();
  expect(deleteCall[1][0]).toBe(FAMILY_ID);
});

test('refresh: reuse detection does not issue a new access token or cookie', async () => {
  db.query.mockResolvedValueOnce({ rows: [makeActiveToken({ revoked: true })] })
    .mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await refresh({ cookies: { refreshToken: 'rotatedtoken' } }, res, jest.fn());
  expect(res.cookie).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
});

test('logout: deletes token family from DB and clears cookie', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ family_id: FAMILY_ID }] }).mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await logout({ cookies: { refreshToken: 'somerawtoken' } }, res, jest.fn());
  const deleteCall = db.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM refresh_tokens') && sql.includes('family_id'));
  expect(deleteCall).toBeDefined();
  expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', expect.any(Object));
  expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
});

test('logout: succeeds gracefully when no cookie is present', async () => {
  const res = mockRes();
  await logout({ cookies: {} }, res, jest.fn());
  expect(db.query).not.toHaveBeenCalled();
  expect(res.clearCookie).toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
});

test('verifyEmail: returns 400 when token missing', async () => {
  const res = mockRes();
  await verifyEmail({ query: {} }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Verification token is required' });
});

test('verifyEmail: returns 400 for unknown token', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await verifyEmail({ query: { token: 'unknowntoken' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid verification token' });
});

test('verifyEmail: returns 400 for expired token', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ id: '1', token_expires_at: new Date(Date.now() - 1000).toISOString() }] });
  const res = mockRes();
  await verifyEmail({ query: { token: 'sometoken' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Verification token has expired' });
});

test('verifyEmail: marks email verified and clears token on valid token', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ id: '1', token_expires_at: new Date(Date.now() + 10000).toISOString() }] })
    .mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await verifyEmail({ query: { token: 'validtoken' } }, res, jest.fn());
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('email_verified = TRUE'), expect.any(Array));
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('verified successfully') }));
});

test('verifyEmail: hashes the raw token before querying DB', async () => {
  const rawToken = 'mytesttoken';
  db.query.mockResolvedValueOnce({ rows: [] });
  const res = mockRes();
  await verifyEmail({ query: { token: rawToken } }, res, jest.fn());
  expect(db.query).toHaveBeenCalledWith(
    expect.stringContaining('verification_token'),
    [crypto.createHash('sha256').update(rawToken).digest('hex')]
  );
});
