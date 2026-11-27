/**
 * BE-193 / BE-194 / BE-195 / BE-196 — phone OTP hardening, auth route
 * limiters, phone OTP resend and SMS log masking.
 */

jest.mock('../db');
jest.mock('../services/stellar');
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/email', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
}));
jest.mock('../services/sms', () => ({ sendOTP: jest.fn().mockResolvedValue({ success: true }) }));

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const sms = require('../services/sms');
const { verifyPhone, resendPhoneOTP } = require('../controllers/authController');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-phone-otp';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function hmac(otp) {
  const secret = process.env.PHONE_OTP_SECRET || process.env.JWT_SECRET;
  return crypto.createHmac('sha256', secret).update(`${USER_ID}:${otp}`).digest('hex');
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(body = {}) {
  return { body, user: { userId: USER_ID }, ip: '127.0.0.1', headers: {} };
}

// Minimal in-memory emulation of the users row for the verify/resend queries.
function installUserState(state) {
  db.query.mockImplementation(async (sql, params) => {
    if (/^\s*SELECT phone_otp_hash/.test(sql)) return { rows: [{ ...state }] };
    if (/SET phone_otp_attempts = phone_otp_attempts \+ 1/.test(sql)) {
      if (state.phone_otp_hash !== params[2]) return { rows: [], rowCount: 0 };
      state.phone_otp_attempts += 1;
      if (state.phone_otp_attempts >= params[1]) {
        state.phone_otp_hash = null;
        state.phone_otp_expires_at = null;
      }
      return { rows: [{ phone_otp_attempts: state.phone_otp_attempts }], rowCount: 1 };
    }
    if (/SET phone_verified = TRUE/.test(sql)) {
      if (state.phone_otp_hash !== params[1]) return { rows: [], rowCount: 0 };
      state.phone_verified = true;
      state.phone_otp_hash = null;
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*SELECT phone, phone_verified/.test(sql)) return { rows: [{ ...state }] };
    if (/FROM phone_otp_sends/.test(sql)) return { rows: [{ count: state.phone_sends || 0, oldest: null }] };
    if (/SET\s+phone_otp_hash = \$2/.test(sql)) {
      state.phone_otp_hash = params[1];
      state.phone_otp_expires_at = params[2];
      state.phone_otp_attempts = 0;
      state.phone_otp_sent_at = new Date();
      return { rows: [{ phone_otp_sent_at: state.phone_otp_sent_at }], rowCount: 1 };
    }
    if (/INSERT INTO phone_otp_sends/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

describe('verifyPhone (BE-193)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('locks the OTP after 5 failures and rejects the correct code until resend', async () => {
    const state = {
      phone: '+2348000000000',
      phone_otp_hash: hmac('123456'),
      phone_otp_expires_at: new Date(Date.now() + 60_000),
      phone_otp_attempts: 0,
    };
    installUserState(state);

    for (let i = 1; i <= 4; i++) {
      const res = mockRes();
      await verifyPhone(mockReq({ otp: '000000' }), res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ attempts_remaining: 5 - i }));
    }

    const fifth = mockRes();
    await verifyPhone(mockReq({ otp: '000000' }), fifth, jest.fn());
    expect(fifth.status).toHaveBeenCalledWith(429);
    expect(fifth.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OTP_LOCKED' }));

    const sixth = mockRes();
    await verifyPhone(mockReq({ otp: '000000' }), sixth, jest.fn());
    expect(sixth.status).toHaveBeenCalledWith(429);
    expect(sixth.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OTP_LOCKED' }));

    const correct = mockRes();
    await verifyPhone(mockReq({ otp: '123456' }), correct, jest.fn());
    expect(correct.status).toHaveBeenCalledWith(429);
    expect(state.phone_verified).toBeUndefined();
  });

  it('verifies a correct OTP stored as a keyed HMAC', async () => {
    const state = {
      phone: '+2348000000000',
      phone_otp_hash: hmac('654321'),
      phone_otp_expires_at: new Date(Date.now() + 60_000),
      phone_otp_attempts: 0,
    };
    installUserState(state);
    const res = mockRes();
    await verifyPhone(mockReq({ otp: '654321' }), res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ message: 'Phone number verified successfully.' });
    expect(state.phone_verified).toBe(true);
  });

  it('a bare SHA-256 of the code does not match the stored value', () => {
    expect(hmac('123456')).not.toBe(crypto.createHash('sha256').update('123456').digest('hex'));
  });
});

describe('resendPhoneOTP (BE-195)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues a new OTP, invalidating the old one, and reports resend_available_at', async () => {
    const state = {
      phone: '+2348000000000',
      phone_verified: false,
      phone_otp_hash: hmac('111111'),
      phone_otp_attempts: 5,
      phone_otp_sent_at: new Date(Date.now() - 5 * 60_000),
      phone_otp_send_count: 1,
      phone_otp_send_window_start: new Date(Date.now() - 5 * 60_000),
    };
    installUserState(state);
    const res = mockRes();
    await resendPhoneOTP(mockReq(), res, jest.fn());
    expect(sms.sendOTP).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ resend_available_at: expect.any(String) }));
    expect(state.phone_otp_hash).not.toBe(hmac('111111'));
    expect(state.phone_otp_attempts).toBe(0);
  });

  it('enforces the 60 s cooldown', async () => {
    installUserState({
      phone: '+2348000000000',
      phone_verified: false,
      phone_otp_sent_at: new Date(Date.now() - 10_000),
      phone_otp_send_count: 1,
      phone_otp_send_window_start: new Date(Date.now() - 10_000),
    });
    const res = mockRes();
    await resendPhoneOTP(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OTP_RESEND_COOLDOWN' }));
    expect(sms.sendOTP).not.toHaveBeenCalled();
  });

  it('enforces the per-user daily cap', async () => {
    installUserState({
      phone: '+2348000000000',
      phone_verified: false,
      phone_otp_sent_at: new Date(Date.now() - 5 * 60_000),
      phone_otp_send_count: 5,
      phone_otp_send_window_start: new Date(Date.now() - 60 * 60_000),
    });
    const res = mockRes();
    await resendPhoneOTP(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OTP_RESEND_LIMIT' }));
  });

  it('enforces the per-phone daily cap', async () => {
    installUserState({
      phone: '+2348000000000',
      phone_verified: false,
      phone_otp_sent_at: null,
      phone_otp_send_count: 0,
      phone_otp_send_window_start: null,
      phone_sends: 10,
    });
    const res = mockRes();
    await resendPhoneOTP(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OTP_RESEND_LIMIT' }));
  });

  it('returns 502 SMS_DELIVERY_FAILED when the provider fails', async () => {
    installUserState({
      phone: '+2348000000000',
      phone_verified: false,
      phone_otp_sent_at: null,
      phone_otp_send_count: 0,
      phone_otp_send_window_start: null,
    });
    sms.sendOTP.mockRejectedValueOnce(new Error('provider down'));
    const res = mockRes();
    await resendPhoneOTP(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SMS_DELIVERY_FAILED' }));
  });
});

describe('auth route limiters (BE-194)', () => {
  it('every POST in routes/auth.js mounts an explicit rate limiter', () => {
    const authRouter = require('../routes/auth');
    const posts = authRouter.stack.filter((layer) => layer.route && layer.route.methods.post);
    expect(posts.length).toBeGreaterThan(0);
    const missing = posts
      .filter((layer) => !layer.route.stack.some((s) => s.handle && s.handle.isRateLimiter))
      .map((layer) => layer.route.path);
    expect(missing).toEqual([]);
  });
});

describe('no Math.random in security-relevant code (BE-193)', () => {
  it('controllers/ and services/ do not use Math.random', () => {
    const offenders = [];
    for (const dir of ['controllers', 'services']) {
      const full = path.join(__dirname, '..', dir);
      for (const file of fs.readdirSync(full)) {
        if (!file.endsWith('.js')) continue;
        if (fs.readFileSync(path.join(full, file), 'utf8').includes('Math.random')) offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('SMS mock provider (BE-196)', () => {
  const realSms = jest.requireActual('../services/sms');
  const logger = require('../utils/logger');
  const originalEnv = { NODE_ENV: process.env.NODE_ENV, SMS_PROVIDER: process.env.SMS_PROVIDER };

  afterEach(() => {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    if (originalEnv.SMS_PROVIDER === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = originalEnv.SMS_PROVIDER;
    jest.restoreAllMocks();
  });

  it('never logs the full OTP', async () => {
    delete process.env.SMS_PROVIDER;
    process.env.NODE_ENV = 'development';
    const lines = [];
    for (const level of ['info', 'warn', 'error', 'debug']) {
      jest.spyOn(logger, level).mockImplementation((...args) => { lines.push(JSON.stringify(args)); });
    }
    await realSms.sendOTP('+2348012345678', '987654');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('987654');
    expect(lines.join('\n')).toContain('****54');
  });

  it('refuses to run the mock in production', async () => {
    delete process.env.SMS_PROVIDER;
    process.env.NODE_ENV = 'production';
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    await expect(realSms.sendOTP('+2348012345678', '987654')).rejects.toThrow('SMS provider is not configured');
  });
});
