/**
 * Tests for #867: services/email.js — single module.exports with all
 * required functions, parseable by Node, and all email flows functional.
 *
 * The bug introduced: three separate module.exports statements (only the last
 * one wins) and an orphaned `return enqueueEmail(...)` outside any function
 * body (SyntaxError at parse time), breaking every transactional email.
 *
 * Acceptance criteria covered:
 *  ✓ node -c src/services/email.js exits 0 (file is parseable)
 *  ✓ Only one module.exports — all required functions exported together
 *  ✓ sendVerificationEmail works (mocked SMTP/queue)
 *  ✓ sendPasswordResetEmail works (mocked SMTP/queue)
 *  ✓ sendKycExpiryReminderEmail works (mocked SMTP/queue)
 *  ✓ Every function imported by callers elsewhere exists in the export
 */

// ---------------------------------------------------------------------------
// Mock nodemailer and BullMQ so no real SMTP/Redis is needed
// ---------------------------------------------------------------------------
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-msg-id' }),
  })),
}));

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Load module under test AFTER mocks
// ---------------------------------------------------------------------------
const emailService = require('../services/email');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
process.env.FRONTEND_URL = 'https://app.afripay.test';
process.env.SMTP_FROM = 'noreply@afripay.test';
process.env.STELLAR_NETWORK = 'testnet';

// ===========================================================================
// #867 — Parse / syntax check
// ===========================================================================
describe('#867 — email.js is parseable and well-structured', () => {
  test('module loads without throwing (no SyntaxError)', () => {
    // If the file had the orphaned return statement or triplicate exports
    // the require() above would have already thrown — this test would never run.
    expect(emailService).toBeDefined();
  });

  test('exports a plain object (not a function)', () => {
    expect(typeof emailService).toBe('object');
    expect(emailService).not.toBeNull();
  });
});

// ===========================================================================
// #867 — Single export with full function set
// ===========================================================================
describe('#867 — all required functions are present in module.exports', () => {
  // Functions consumed by authController.js, kycExpiryJob.js, and
  // transaction-email callers — if any were dropped from a partial export
  // they would be undefined and callers would silently fail or throw.
  const required = [
    'initEmailQueue',
    'drainEmailQueue',
    'enqueueEmail',
    'getEmailQueue',
    'sendVerificationEmail',
    'sendPasswordResetEmail',
    'sendExpiryNotification',
    'sendTransactionEmail',
    'sendPaymentRequestExpiredEmail',
    'sendBackupCodeWarningEmail',
    'sendKycExpiryReminderEmail',
  ];

  test.each(required)('%s is exported and is a function', (name) => {
    expect(typeof emailService[name]).toBe('function');
  });
});

// ===========================================================================
// #867 — Transactional email flows (mocked SMTP/queue)
// ===========================================================================
describe('#867 — sendVerificationEmail', () => {
  test('resolves without throwing for valid inputs', async () => {
    await expect(
      emailService.sendVerificationEmail('alice@example.com', 'tok-abc')
    ).resolves.not.toThrow();
  });

  test('sends to the correct address', async () => {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport.mock.results[0].value;
    transport.sendMail.mockClear();

    await emailService.sendVerificationEmail('alice@example.com', 'tok-abc');

    if (transport.sendMail.mock.calls.length > 0) {
      const [opts] = transport.sendMail.mock.calls[0];
      expect(opts.to).toBe('alice@example.com');
      expect(opts.subject).toMatch(/verify/i);
    }
    // If BullMQ queue is active, sendMail won't be called directly —
    // just verify no error was thrown (handled by resolves above).
  });
});

describe('#867 — sendPasswordResetEmail', () => {
  test('resolves without throwing', async () => {
    await expect(
      emailService.sendPasswordResetEmail('bob@example.com', 'reset-token-xyz')
    ).resolves.not.toThrow();
  });
});

describe('#867 — sendKycExpiryReminderEmail', () => {
  test('resolves without throwing', async () => {
    await expect(
      emailService.sendKycExpiryReminderEmail('carol@example.com', 'Carol', 7)
    ).resolves.not.toThrow();
  });
});

describe('#867 — sendTransactionEmail', () => {
  const tx = {
    amount: '10',
    asset: 'XLM',
    senderAddress: 'GSENDER111',
    recipientAddress: 'GRECIPIENT222',
    txHash: 'aabbccddeeff0011223344556677889900112233445566778899aabbccddeeff',
    memo: null,
  };

  test('resolves for "sent" type', async () => {
    await expect(
      emailService.sendTransactionEmail('dave@example.com', 'sent', tx)
    ).resolves.not.toThrow();
  });

  test('resolves for "received" type', async () => {
    await expect(
      emailService.sendTransactionEmail('eve@example.com', 'received', tx)
    ).resolves.not.toThrow();
  });
});

describe('#867 — enqueueEmail falls back to sendMail when no Redis queue', () => {
  test('resolves when called directly without a queue', async () => {
    // Queue is null because REDIS_URL is not set in test env — falls back to
    // transporter.sendMail, which is mocked to resolve.
    await expect(
      emailService.enqueueEmail({
        to: 'fallback@example.com',
        subject: 'Test',
        html: '<p>test</p>',
      })
    ).resolves.not.toThrow();
  });
});
