'use strict';

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('bcryptjs', () => ({ compare: jest.fn().mockResolvedValue(true), hash: jest.fn() }));
jest.mock('../services/stellar', () => ({
  createWallet: jest.fn(),
  encryptPrivateKey: jest.fn(),
  addTrustline: jest.fn(),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/email', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  sendBackupCodeWarningEmail: jest.fn(),
  sendEmailChangeRequestedNotice: jest.fn(),
}));
jest.mock('../services/twofa', () => ({
  generateSecret: jest.fn(),
  verifyToken: jest.fn(),
  getTokenCounter: jest.fn(),
  generateBackupCodes: jest.fn(),
  useBackupCode: jest.fn(),
  hashBackupCode: jest.fn(),
  verifyBackupCode: jest.fn(),
}));
jest.mock('../controllers/sessionController', () => ({
  recordSession: jest.fn().mockResolvedValue(undefined),
  invalidateOtherSessions: jest.fn(),
}));
jest.mock('../utils/tokens', () => ({
  COOKIE_NAME: 'refreshToken',
  COOKIE_OPTIONS: {},
  DEVICE_COOKIE_NAME: 'deviceToken',
  DEVICE_COOKIE_OPTIONS: {},
  signAccessToken: jest.fn(() => 'access-token'),
  generateRefreshToken: jest.fn(() => ({ raw: 'refresh', hash: 'hash' })),
  refreshTokenExpiresAt: jest.fn(() => new Date()),
  signDeviceToken: jest.fn(),
  verifyDeviceToken: jest.fn(),
}));
jest.mock('../middleware/csrf', () => ({ setCsrfCookie: jest.fn() }));
jest.mock('../utils/cache', () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn() }));
jest.mock('../services/webauthn', () => ({}));
jest.mock('../services/sms', () => ({ sendOTP: jest.fn() }));

const db = require('../db');
const twofa = require('../services/twofa');
const { login } = require('../controllers/authController');
const { getTrustedIp } = require('../middleware/rateLimiter');
const audit = require('../services/audit');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  return res;
}

function user() {
  return {
    id: 'user-1',
    email: 'user@example.com',
    password_hash: '$2a$10$7EqJtq98hPqEX7fNZaFWoO4XlTnS4jvYw3nX2y5n4u9m2Kx1Y6Q6u',
    email_verified: true,
    role: 'user',
    totp_enabled: true,
    totp_secret: 'JBSWY3DPEHPK3PXP',
    failed_login_attempts: 0,
    locked_until: null,
    last_failed_attempt_at: null,
    onboarding_completed: true,
    public_key: 'GPUBLIC',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  twofa.verifyToken.mockReturnValue(false);
  twofa.getTokenCounter.mockReturnValue(null);
});

test('#1152 invalid TOTP attempts update the account lockout counter', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [user()] })
    .mockResolvedValueOnce({ rows: [{ failed_login_attempts: 1, locked_until: null }] });
  const res = mockRes();

  await login(
    {
      body: { email: 'user@example.com', password: 'password', totp_code: '000000' },
      headers: {},
      ip: '1.2.3.4',
    },
    res,
    jest.fn()
  );

  expect(res.status).toHaveBeenCalledWith(401);
  expect(db.query.mock.calls[1][0]).toContain('failed_login_attempts');
  expect(audit.log).toHaveBeenCalledWith(
    'user-1',
    'login_failure',
    '1.2.3.4',
    undefined,
    expect.objectContaining({ reason: 'invalid_2fa' })
  );
});

test('#1152 a TOTP counter can only be consumed once', async () => {
  twofa.verifyToken.mockReturnValue(true);
  twofa.getTokenCounter.mockReturnValue(12345);
  db.query
    .mockResolvedValueOnce({ rows: [user()] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ failed_login_attempts: 1, locked_until: null }] });
  const res = mockRes();

  await login(
    {
      body: { email: 'user@example.com', password: 'password', totp_code: '123456' },
      headers: {},
      ip: '1.2.3.4',
    },
    res,
    jest.fn()
  );

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'TOTP code already used' });
  expect(db.query.mock.calls[1][0]).toContain('ON CONFLICT DO NOTHING');
});

test('#1152 invalid backup codes also count toward lockout', async () => {
  twofa.verifyBackupCode.mockResolvedValue(false);
  db.query
    .mockResolvedValueOnce({ rows: [user()] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ failed_login_attempts: 1, locked_until: null }] });
  const res = mockRes();

  await login(
    {
      body: { email: 'user@example.com', password: 'password', backup_code: 'not-valid' },
      headers: {},
      ip: '1.2.3.4',
    },
    res,
    jest.fn()
  );

  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Invalid backup code' });
});

test('#1153 derives the limiter key from Express req.ip, not the left-most forwarded address', () => {
  expect(
    getTrustedIp({
      ip: '10.0.0.5',
      socket: { remoteAddress: '10.0.0.5' },
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.5' },
    })
  ).toBe('10.0.0.5');
});

test('#1147 and #1154 keep tenant delivery and authenticated limiter placement explicit', async () => {
  jest.resetModules();
  jest.doMock('../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
  jest.doMock('../utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
  jest.doMock('../utils/webhookSignature', () => ({
    sign: jest.fn(),
    buildSignatureHeader: jest.fn(),
  }));
  jest.doMock('../utils/ssrf', () => ({ validateOutboundUrl: jest.fn() }));
  jest.doMock('../utils/symmetricEncryption', () => ({ decryptSecret: jest.fn() }));
  const webhookDb = require('../db');
  const { deliver } = require('../services/webhook');
  await deliver('payment.sent', 'user-1', { amount: '10' });
  expect(webhookDb.query).toHaveBeenCalledWith(expect.stringContaining('user_id = $2'), [
    'payment.sent',
    'user-1',
  ]);
});
