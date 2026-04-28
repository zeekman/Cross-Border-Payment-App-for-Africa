jest.mock('../src/db');
jest.mock('../src/services/stellar');
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));
jest.mock('../src/services/email', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn()
}));

const crypto = require('crypto');
const db = require('../src/db');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../src/services/email');
const { createWallet } = require('../src/services/stellar');
const {
  register,
  login,
  refresh,
  logout,
  verifyEmail,
  getMe,
  forgotPassword,
  resetPassword,
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
  db.query
    .mockResolvedValueOnce({
      rows: [{
        id: '1',
        full_name: 'Alice',
        email: 'a@b.com',
        password_hash: hash,
        email_verified: true,
        role: 'user',
        totp_enabled: false,
        failed_login_attempts: 0,
        locked_until: null,
        public_key: 'GPUB'
      }]
    })
    .mockResolvedValueOnce({ rows: [] });

  const req = { body: { email: 'a@b.com', password: 'wrongpass' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid email or password' });
});

test('login: locks account after 10 consecutive failed attempts', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('correctpass', 12);
  db.query
    .mockResolvedValueOnce({
      rows: [{
        id: '1',
        full_name: 'Alice',
        email: 'a@b.com',
        password_hash: hash,
        email_verified: true,
        role: 'user',
        totp_enabled: false,
        failed_login_attempts: 9,
        locked_until: null,
        public_key: 'GPUB'
      }]
    })
    .mockResolvedValueOnce({ rows: [] });

  const req = { body: { email: 'a@b.com', password: 'wrongpass' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(423);
  expect(res.json).toHaveBeenCalledWith({
    error: expect.stringMatching(/^Account locked until .*Z$/),
  });
});

test('login: returns 423 when account is locked', async () => {
  const future = new Date(Date.now() + 15 * 60 * 1000).toISOString();
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
      totp_enabled: false,
      failed_login_attempts: 10,
      locked_until: future,
      public_key: 'GPUB'
    }]
  });

  const req = { body: { email: 'a@b.com', password: 'correctpass' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(423);
  expect(res.json).toHaveBeenCalledWith({ error: `Account locked until ${future}` });
  expect(db.query).toHaveBeenCalledTimes(1);
});

test('login: resets failed login counter on successful login', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query
    .mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          full_name: 'Alice',
          email: 'a@b.com',
          password_hash: hash,
          email_verified: true,
          role: 'user',
          totp_enabled: false,
          failed_login_attempts: 3,
          locked_until: null,
          public_key: 'GPUB',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const req = { body: { email: 'a@b.com', password: 'password1' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  expect(db.query.mock.calls[1][0]).toContain('UPDATE users SET failed_login_attempts = 0, locked_until = NULL');
  expect(res.status).not.toHaveBeenCalledWith(401);
  expect(res.status).not.toHaveBeenCalledWith(403);
  expect(res.json.mock.calls[0][0].token).toBeDefined();
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
      rows: [
        {
          id: '1',
          full_name: 'Alice',
          email: 'a@b.com',
          password_hash: hash,
          email_verified: true,
          role: 'user',
          public_key: 'GPUB',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] }); // account reset + INSERT refresh_token

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
      rows: [
        {
          id: '1',
          full_name: 'Alice',
          email: 'a@b.com',
          password_hash: hash,
          email_verified: true,
          role: 'user',
          public_key: 'GPUB',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] }); // INSERT refresh_token

  const req = { body: { email: 'a@b.com', password: 'password1' } };
  const res = mockRes();
  await login(req, res, jest.fn());

  expect(res.cookie).toHaveBeenCalledWith(
    'refreshToken',
    expect.any(String),
    expect.objectContaining({ httpOnly: true, sameSite: 'lax' })
  );
});

test('login: stores hashed refresh token in DB, not the raw value', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password1', 12);
  db.query
    .mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          full_name: 'Alice',
          email: 'a@b.com',
          password_hash: hash,
          email_verified: true,
          role: 'user',
          public_key: 'GPUB',
        },
      ],
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

test('login: seeds a family_id when issuing the first refresh token', async () => {
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

  const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_tokens'));
  expect(insertCall).toBeDefined();
  // family_id is the 5th param (index 4) — must be a UUID
  const familyId = insertCall[1][4];
  expect(familyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

// ── refresh ───────────────────────────────────────────────────────────────────

const FAMILY_ID = 'fam-uuid-1234-5678-abcd-ef0123456789';

function makeActiveToken(overrides = {}) {
  return {
    id: 'rt-1',
    user_id: 'u-1',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    family_id: FAMILY_ID,
    revoked: false,
    email: 'a@b.com',
    role: 'user',
    ...overrides,
  };
}

test('refresh: returns 401 when no cookie present', async () => {
  const req = { cookies: {} };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'No refresh token' });
});

test('refresh: returns 401 for completely unknown token (not in DB at all)', async () => {
  // First lookup: not found. Second lookup (revoked check): also not found.
  db.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const req = { cookies: { refreshToken: 'unknownrawtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid refresh token' });
});

test('refresh: returns 401 and clears cookie for expired token', async () => {
  db.query
    .mockResolvedValueOnce({
      rows: [makeActiveToken({ expires_at: new Date(Date.now() - 1000).toISOString() })]
    })
    .mockResolvedValueOnce({ rows: [] }); // DELETE expired

  const req = { cookies: { refreshToken: 'expiredrawtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Refresh token expired' });
  expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', expect.any(Object));
});

test('refresh: rotates token — marks old revoked and inserts new one', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [makeActiveToken()] }) // lookup
    .mockResolvedValueOnce({ rows: [] })                  // UPDATE revoked=TRUE
    .mockResolvedValueOnce({ rows: [] });                 // INSERT new

  const req = { cookies: { refreshToken: 'validrawtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: expect.any(String) }));
  expect(res.cookie).toHaveBeenCalledWith('refreshToken', expect.any(String), expect.objectContaining({ httpOnly: true }));

  const updateCall = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE refresh_tokens') && sql.includes('revoked'));
  expect(updateCall).toBeDefined();

  const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_tokens'));
  expect(insertCall).toBeDefined();
});

test('refresh: new token carries the same family_id as the old one', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [makeActiveToken()] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const req = { cookies: { refreshToken: 'validrawtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO refresh_tokens'));
  expect(insertCall).toBeDefined();
  // family_id is the 5th param (index 4)
  expect(insertCall[1][4]).toBe(FAMILY_ID);
});

test('refresh: new cookie token differs from old one (rotation)', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [makeActiveToken()] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const oldRaw = 'oldrawtoken12345';
  const req = { cookies: { refreshToken: oldRaw } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  const newRaw = res.cookie.mock.calls[0][1];
  expect(newRaw).not.toBe(oldRaw);
});

// ── refresh: token reuse detection ───────────────────────────────────────────

test('refresh: detects reuse of a rotated token — invalidates entire family', async () => {
  // Attacker presents a previously-rotated (revoked) token.
  // First lookup (active): not found (it was rotated away).
  // Second lookup (revoked check): found with family_id.
  db.query
    .mockResolvedValueOnce({ rows: [] })                                          // active lookup: miss
    .mockResolvedValueOnce({ rows: [{ family_id: FAMILY_ID, user_id: 'u-1' }] }) // revoked lookup: hit
    .mockResolvedValueOnce({ rows: [] });                                         // DELETE family

  const req = { cookies: { refreshToken: 'rotatedtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.stringMatching(/reuse detected/i) })
  );
  expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', expect.any(Object));

  // Entire family must be deleted
  const deleteCall = db.query.mock.calls.find(([sql]) =>
    sql.includes('DELETE FROM refresh_tokens') && sql.includes('family_id')
  );
  expect(deleteCall).toBeDefined();
  expect(deleteCall[1][0]).toBe(FAMILY_ID);
});

test('refresh: reuse detection does not issue a new access token', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ family_id: FAMILY_ID, user_id: 'u-1' }] })
    .mockResolvedValueOnce({ rows: [] });

  const req = { cookies: { refreshToken: 'rotatedtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  // No new cookie should be set
  expect(res.cookie).not.toHaveBeenCalled();
  // Response must be 401, not 200
  expect(res.status).toHaveBeenCalledWith(401);
});

test('refresh: reuse of a token that is still in DB as revoked also invalidates family', async () => {
  // Edge case: the revoked row is still present in the active lookup (revoked=true)
  db.query
    .mockResolvedValueOnce({ rows: [makeActiveToken({ revoked: true })] }) // found but revoked
    .mockResolvedValueOnce({ rows: [] });                                   // DELETE family

  const req = { cookies: { refreshToken: 'revokedtoken' } };
  const res = mockRes();
  await refresh(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.stringMatching(/reuse detected/i) })
  );

  const deleteCall = db.query.mock.calls.find(([sql]) =>
    sql.includes('DELETE FROM refresh_tokens') && sql.includes('family_id')
  );
  expect(deleteCall).toBeDefined();
  expect(deleteCall[1][0]).toBe(FAMILY_ID);
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
    .mockResolvedValueOnce({ rows: [] })  // BEGIN
    .mockResolvedValueOnce({ rows: [] })  // UPDATE users
    .mockResolvedValueOnce({ rows: [] })  // UPDATE password_reset_tokens
    .mockResolvedValueOnce({ rows: [] })  // DELETE refresh_tokens
    .mockResolvedValueOnce({ rows: [] }); // COMMIT

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

test('resetPassword: deletes all refresh tokens for user after reset', async () => {
  const audit = require('../src/services/audit');
  db.query
    .mockResolvedValueOnce({ rows: [{ id: 't1', user_id: 'u1' }] })
    .mockResolvedValueOnce({ rows: [] })  // BEGIN
    .mockResolvedValueOnce({ rows: [] })  // UPDATE users
    .mockResolvedValueOnce({ rows: [] })  // UPDATE password_reset_tokens
    .mockResolvedValueOnce({ rows: [] })  // DELETE refresh_tokens
    .mockResolvedValueOnce({ rows: [] }); // COMMIT

  const req = { body: { token: 'raw-reset-token', password: 'newpass12' }, ip: '1.2.3.4', headers: { 'user-agent': 'test' } };
  const res = mockRes();
  await resetPassword(req, res, jest.fn());

  const deleteCall = db.query.mock.calls.find(
    (c) => typeof c[0] === 'string' && c[0].includes('DELETE FROM refresh_tokens')
  );
  expect(deleteCall).toBeDefined();
  expect(deleteCall[1][0]).toBe('u1');

  expect(audit.log).toHaveBeenCalledWith('u1', 'password_reset_sessions_invalidated', expect.anything(), expect.anything());
});

// ── getMe ─────────────────────────────────────────────────────────────────────

test('getMe: returns user data for valid JWT', async () => {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: 'u1',
      full_name: 'Alice',
      email: 'a@b.com',
      phone: '+1234',
      pin_setup_completed: true,
      totp_enabled: false,
      account_type: 'personal',
      public_key: 'GPUB',
    }],
  });

  const req = { user: { userId: 'u1' } };
  const res = mockRes();
  await getMe(req, res, jest.fn());

  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    id: 'u1',
    email: 'a@b.com',
    wallet_address: 'GPUB',
  }));
});

test('getMe: returns 404 when user not found', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });

  const req = { user: { userId: 'missing' } };
  const res = mockRes();
  await getMe(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
});
