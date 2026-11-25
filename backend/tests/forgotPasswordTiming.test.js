/**
 * Tests for issue #267:
 * POST /api/auth/forgot-password must not leak user existence via response timing.
 * Fix: respond immediately after DB check; email sending is async (fire-and-forget).
 */
jest.mock('../src/db');
jest.mock('../src/services/email', () => ({
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/stellar', () => ({
  createWallet: jest.fn(),
  encryptPrivateKey: jest.fn(),
  addTrustline: jest.fn(),
}));

const db = require('../src/db');
const { sendPasswordResetEmail } = require('../src/services/email');
const { forgotPassword } = require('../src/controllers/authController');

const FORGOT_PASSWORD_RESPONSE = {
  message: 'If an account exists for this email, you will receive password reset instructions shortly.',
};

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => jest.clearAllMocks());

describe('forgotPassword — timing safety (#267)', () => {
  test('returns 200 with standard message for unknown email', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const req = { body: { email: 'nobody@example.com' } };
    const res = mockRes();
    await forgotPassword(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(FORGOT_PASSWORD_RESPONSE);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('returns 200 with standard message for known email', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValue({ rows: [] });

    const req = { body: { email: 'alice@example.com' } };
    const res = mockRes();
    await forgotPassword(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(FORGOT_PASSWORD_RESPONSE);
  });

  test('response times for existing and non-existing emails are within 100ms', async () => {
    // Unknown email — only one DB query
    db.query.mockResolvedValue({ rows: [] });
    const req1 = { body: { email: 'nobody@example.com' } };
    const res1 = mockRes();
    const t0 = Date.now();
    await forgotPassword(req1, res1, jest.fn());
    const unknownMs = Date.now() - t0;

    jest.clearAllMocks();

    // Known email — DB query returns a user; subsequent writes are async
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValue({ rows: [] });
    const req2 = { body: { email: 'alice@example.com' } };
    const res2 = mockRes();
    const t1 = Date.now();
    await forgotPassword(req2, res2, jest.fn());
    const knownMs = Date.now() - t1;

    expect(Math.abs(knownMs - unknownMs)).toBeLessThan(100);
  });

  test('email is sent asynchronously after response (fire-and-forget)', async () => {
    // Simulate slow email sending — should not block the response
    sendPasswordResetEmail.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 200))
    );
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
      .mockResolvedValue({ rows: [] });

    const req = { body: { email: 'alice@example.com' } };
    const res = mockRes();
    const t0 = Date.now();
    await forgotPassword(req, res, jest.fn());
    const elapsed = Date.now() - t0;

    // Response must return well before the 200ms email delay
    expect(elapsed).toBeLessThan(100);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
