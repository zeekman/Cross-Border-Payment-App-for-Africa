jest.mock('../src/db');
jest.mock('../src/services/stellar');
jest.mock('../src/services/email', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn()
}));

const crypto = require('crypto');
const db = require('../src/db');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../src/services/email');
const { createWallet } = require('../src/services/stellar');
const { register, login, refresh, logout, verifyEmail } = require('../src/controllers/authController');
const {
  register,
  login,
  verifyEmail,
  forgotPassword,
  resetPassword
} = require('../src/controllers/authController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = 'test_secret';
  process.env.FRONTEND_URL = 'http://localhost:3000';
  createWallet.mockResolvedValue({ publicKey: 'GPUBKEY', encryptedSecretKey: 'enc' });
  sendVerificationEmail.mockResolvedValue();
  sendPasswordResetEmail.mockResolvedValue();
});

// ── register ──────────────────────────────────────────────────────────────────

test('register: returns 409 if email already exists', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ id: '1' }] });

  const req = { body: { full_name: 'Alice', email: 'a@b.com', password: 'password1' } };
  const res = mockRes();
  await register(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith({ error: 'Email already registered' });
});

test('register: creates user and sends verification email', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [] })       // check existing
    .mockResolvedValueOnce({ rows: [] })       // BEGIN
    .mockResolvedValueOnce({ rows: [] })       // INSERT users
    .mockResolvedValueOnce({ rows: [] })       // INSERT wallets
    .mockResolvedValueOnce({ rows: [] });      // COMMIT

  const req = { body: { full_name: 'Alice', email: 'a@b.com', password: 'password1' } };
  const res = mockRes();
  await register(req, res, jest.fn());

  expect(sendVerificationEmail).toHaveBeenCalledWith('a@b.com', expect.any(String));
  expect(res.status).toHaveBeenCalledWith(201);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('verify your email') })
  );
});

test('register: does NOT return a JWT token', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const req = { body: { full_name: 'Alice', email: 'a@b.com', password: 'password1' } };
  const res = mockRes();
  await register(req, res, jest.fn());

  const payload = res.json.mock.calls[0][0];
  expect(payload.token).toBeUndefined();
});

// ── login ─────────────────────────────────────────────────────────────────────

test('login: returns 401 for wrong password', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('correctpass', 12);
  db.query.mockResolvedValueOnce({
    rows: [{
      id: '1',
      full_name: 'Alice',
      email: 'a@b.com',
      password_hash: hash,
      email_verified: true,
      role: 'user',
      public_key: 'GPUB'
    }]
  });

  const req = { body: { email: 'a@b.com', password: 'wrongpass' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid email or password' });
});

test('login: returns 403 when email not verified', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query.mockResolvedValueOnce({
    rows: [{
      id: '1',
      full_name: 'Alice',
      email: 'a@b.com',
      password_hash: hash,
      email_verified: false,
      role: 'user',
      public_key: 'GPUB'
    }]
  });

  const req = { body: { email: 'a@b.com', password: 'password1' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: 'Please verify your email before logging in.' });
});

test('login: returns JWT when credentials valid and email verified', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query
    .mockResolvedValueOnce({
      rows: [{ id: '1', full_name: 'Alice', email: 'a@b.com', password_hash: hash, email_verified: true, public_key: 'GPUB' }]
    })
    .mockResolvedValueOnce({ rows: [] }); // INSERT refresh_token
  db.query.mockResolvedValueOnce({
    rows: [{
      id: '1',
      full_name: 'Alice',
      email: 'a@b.com',
      password_hash: hash,
      email_verified: true,
      role: 'user',
      public_key: 'GPUB'
    }]
  });

  const req = { body: { email: 'a@b.com', password: 'password1' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  expect(res.status).not.toHaveBeenCalledWith(401);
  expect(res.status).not.toHaveBeenCalledWith(403);
  const payload = res.json.mock.calls[0][0];
  expect(payload.token).toBeDefined();
});

test('login: sets HttpOnly refreshToken cookie on success', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query
    .mockResolvedValueOnce({
      rows: [{ id: '1', full_name: 'Alice', email: 'a@b.com', password_hash: hash, email_verified: true, public_key: 'GPUB' }]
    })
    .mockResolvedValueOnce({ rows: [] }); // INSERT refresh_token

  const req = { body: { email: 'a@b.com', password: 'password1' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  expect(res.cookie).toHaveBeenCalledWith(
    'refreshToken',
    expect.any(String),
    expect.objectContaining({ httpOnly: true, sameSite: 'strict' })
  );
});

test('login: stores hashed refresh token in DB, not the raw value', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query
    .mockResolvedValueOnce({
      rows: [{ id: '1', full_name: 'Alice', email: 'a@b.com', password_hash: hash, email_verified: true, public_key: 'GPUB' }]
    })
    .mockResolvedValueOnce({ rows: [] });

  const req = { body: { email: 'a@b.com', password: 'password1' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  // The raw token sent in the cookie
  const rawToken = res.cookie.mock.calls[0][1];

  // The value stored in DB must be the SHA-256 hash, not the raw token
  const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_tokens'));
  expect(insertCall).toBeDefined();
  const storedHash = insertCall[1][2]; // 3rd param: token_hash
  expect(storedHash).not.toBe(rawToken);
  expect(storedHash).toBe(crypto.createHash('sha256').update(rawToken).digest('hex'));
});

// ── refresh ───────────────────────────────────────────────────────────────────

test('refresh: returns 401 when no cookie present', async () => {
  const req = { cookies: {} };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'No refresh token' });
});

test('refresh: returns 401 for unknown token', async () => {
  db.query.mockResolvedValueOnce({ rows: [] }); // lookup returns nothing

  const req = { cookies: { refreshToken: 'unknownrawtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid refresh token' });
});

test('refresh: returns 401 and clears cookie for expired token', async () => {
  db.query.mockResolvedValueOnce({
    rows: [{ id: 'rt-1', user_id: 'u-1', expires_at: new Date(Date.now() - 1000).toISOString(), email: 'a@b.com', role: 'user' }]
  })
  .mockResolvedValueOnce({ rows: [] }); // DELETE

  const req = { cookies: { refreshToken: 'expiredrawtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Refresh token expired' });
  expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', expect.any(Object));
});

test('refresh: rotates token and returns new access token', async () => {
  db.query
    .mockResolvedValueOnce({
      rows: [{ id: 'rt-1', user_id: 'u-1', expires_at: new Date(Date.now() + 60000).toISOString(), email: 'a@b.com', role: 'user' }]
    })
    .mockResolvedValueOnce({ rows: [] }) // DELETE old
    .mockResolvedValueOnce({ rows: [] }); // INSERT new

  const req = { cookies: { refreshToken: 'validrawtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: expect.any(String) }));
  expect(res.cookie).toHaveBeenCalledWith('refreshToken', expect.any(String), expect.objectContaining({ httpOnly: true }));

  // Old token must be deleted
  const deleteCall = db.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM refresh_tokens'));
  expect(deleteCall).toBeDefined();

  // New token must be inserted
  const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_tokens'));
  expect(insertCall).toBeDefined();
});

test('refresh: new cookie token differs from old one (rotation)', async () => {
  db.query
    .mockResolvedValueOnce({
      rows: [{ id: 'rt-1', user_id: 'u-1', expires_at: new Date(Date.now() + 60000).toISOString(), email: 'a@b.com', role: 'user' }]
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const oldRaw = 'oldrawtoken12345';
  const req = { cookies: { refreshToken: oldRaw } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  const newRaw = res.cookie.mock.calls[0][1];
  expect(newRaw).not.toBe(oldRaw);
});

// ── logout ────────────────────────────────────────────────────────────────────

test('logout: deletes refresh token from DB and clears cookie', async () => {
  db.query.mockResolvedValueOnce({ rows: [] }); // DELETE

  const req = { cookies: { refreshToken: 'somerawtoken' } };
  const res = mockRes();
  await logout(req, res, jest.fn());

  const deleteCall = db.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM refresh_tokens'));
  expect(deleteCall).toBeDefined();
  expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', expect.any(Object));
  expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
});

test('logout: succeeds gracefully when no cookie is present', async () => {
  const req = { cookies: {} };
  const res = mockRes();
  await logout(req, res, jest.fn());

  expect(db.query).not.toHaveBeenCalled();
  expect(res.clearCookie).toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
});

// ── verifyEmail ───────────────────────────────────────────────────────────────

test('verifyEmail: returns 400 when token missing', async () => {
  const req = { query: {} };
  const res = mockRes();
  await verifyEmail(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Verification token is required' });
});

test('verifyEmail: returns 400 for unknown token', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });

  const req = { query: { token: 'unknowntoken' } };
  const res = mockRes();
  await verifyEmail(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid verification token' });
});

test('verifyEmail: returns 400 for expired token', async () => {
  db.query.mockResolvedValueOnce({
    rows: [{ id: '1', token_expires_at: new Date(Date.now() - 1000).toISOString() }]
  });

  const req = { query: { token: 'sometoken' } };
  const res = mockRes();
  await verifyEmail(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Verification token has expired' });
});

test('verifyEmail: marks email verified and clears token on valid token', async () => {
  db.query
    .mockResolvedValueOnce({
      rows: [{ id: '1', token_expires_at: new Date(Date.now() + 10000).toISOString() }]
    })
    .mockResolvedValueOnce({ rows: [] }); // UPDATE

  const req = { query: { token: 'validtoken' } };
  const res = mockRes();
  await verifyEmail(req, res, jest.fn());

  expect(db.query).toHaveBeenCalledWith(
    expect.stringContaining('email_verified = TRUE'),
    expect.any(Array)
  );
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('verified successfully') })
  );
});

test('verifyEmail: hashes the raw token before querying DB', async () => {
  const rawToken = 'mytesttoken';
  const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  db.query.mockResolvedValueOnce({ rows: [] });

  const req = { query: { token: rawToken } };
  const res = mockRes();
  await verifyEmail(req, res, jest.fn());

  expect(db.query).toHaveBeenCalledWith(
    expect.stringContaining('verification_token'),
    [expectedHash]
  );
});

// ── forgotPassword / resetPassword ────────────────────────────────────────────

const FORGOT_PASSWORD_RESPONSE = {
  message:
    'If an account exists for this email, you will receive password reset instructions shortly.'
};

test('forgotPassword: returns 200 and does not send email when email unknown', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });

  const req = { body: { email: 'nobody@example.com' } };
  const res = mockRes();
  await forgotPassword(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(FORGOT_PASSWORD_RESPONSE);
  expect(sendPasswordResetEmail).not.toHaveBeenCalled();
});

test('forgotPassword: returns 200, replaces pending tokens, sends email when user exists', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const req = { body: { email: 'alice@example.com' } };
  const res = mockRes();
  await forgotPassword(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(FORGOT_PASSWORD_RESPONSE);
  expect(sendPasswordResetEmail).toHaveBeenCalledWith('alice@example.com', expect.any(String));
  expect(db.query).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM password_reset_tokens'),
    ['u1']
  );
});

test('forgotPassword: stores hashed token in database, not raw secret', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const req = { body: { email: 'alice@example.com' } };
  const res = mockRes();
  await forgotPassword(req, res, jest.fn());

  const raw = sendPasswordResetEmail.mock.calls[0][1];
  const expectedHash = crypto.createHash('sha256').update(raw).digest('hex');
  const insertCall = db.query.mock.calls.find(
    (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO password_reset_tokens')
  );
  expect(insertCall[1][1]).toBe(expectedHash);
  expect(insertCall[1][1]).not.toBe(raw);
});

test('resetPassword: returns 400 when token missing', async () => {
  const req = { body: { password: 'newpass12' } };
  const res = mockRes();
  await resetPassword(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Reset token is required' });
});

test('resetPassword: returns 400 for invalid or expired token', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });

  const req = { body: { token: 'bad', password: 'newpass12' } };
  const res = mockRes();
  await resetPassword(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired reset token' });
});

test('resetPassword: updates password and marks tokens used', async () => {
  const bcrypt = require('bcryptjs');
  db.query
    .mockResolvedValueOnce({ rows: [{ id: 't1', user_id: 'u1' }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const req = { body: { token: 'raw-reset-token', password: 'newpass12' } };
  const res = mockRes();
  await resetPassword(req, res, jest.fn());

  expect(db.query).toHaveBeenCalledWith('BEGIN');
  expect(db.query).toHaveBeenCalledWith('COMMIT');
  const updateUser = db.query.mock.calls.find(
    (c) => typeof c[0] === 'string' && c[0].includes('UPDATE users SET password_hash')
  );
  expect(updateUser[1][1]).toBe('u1');
  expect(await bcrypt.compare('newpass12', updateUser[1][0])).toBe(true);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('reset') })
  );
});
