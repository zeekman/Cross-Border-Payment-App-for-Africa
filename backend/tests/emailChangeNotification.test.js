/**
 * Tests for issue #955 (BE-008): requesting an email change must notify the
 * *current* address (account-takeover detection), not just send a
 * verification link to the new one.
 */
jest.mock('../src/db');
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));
jest.mock('../src/services/email', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(),
  sendEmailChangeRequestedNotice: jest.fn().mockResolvedValue(),
}));

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { sendVerificationEmail, sendEmailChangeRequestedNotice } = require('../src/services/email');
const { changeEmail } = require('../src/controllers/authController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('changeEmail: queues a notification to the current address, including IP and user-agent', async () => {
  const passwordHash = await bcrypt.hash('correct-password', 10);
  db.query
    .mockResolvedValueOnce({ rows: [{ password_hash: passwordHash, email: 'old@example.com' }] }) // SELECT password_hash, email
    .mockResolvedValueOnce({ rows: [] }) // SELECT existing email check
    .mockResolvedValueOnce({ rows: [] }); // UPDATE users SET pending_email ...

  const req = {
    body: { new_email: 'new@example.com', password: 'correct-password' },
    user: { userId: 'u1' },
    ip: '203.0.113.7',
    headers: { 'user-agent': 'test-agent/1.0' },
  };
  const res = mockRes();
  const next = jest.fn();

  await changeEmail(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(sendVerificationEmail).toHaveBeenCalledWith('new@example.com', expect.any(String));
  expect(sendEmailChangeRequestedNotice).toHaveBeenCalledWith(
    'old@example.com',
    'new@example.com',
    '203.0.113.7',
    'test-agent/1.0'
  );
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('Verification email sent') })
  );
});

test('changeEmail: does not notify the old address when the password check fails', async () => {
  const passwordHash = await bcrypt.hash('correct-password', 10);
  db.query.mockResolvedValueOnce({ rows: [{ password_hash: passwordHash, email: 'old@example.com' }] });

  const req = {
    body: { new_email: 'new@example.com', password: 'wrong-password' },
    user: { userId: 'u1' },
    ip: '203.0.113.7',
    headers: { 'user-agent': 'test-agent/1.0' },
  };
  const res = mockRes();
  const next = jest.fn();

  await changeEmail(req, res, next);

  expect(res.status).toHaveBeenCalledWith(401);
  expect(sendEmailChangeRequestedNotice).not.toHaveBeenCalled();
  expect(sendVerificationEmail).not.toHaveBeenCalled();
});
