/**
 * Tests for the password policy — the single source of truth for password
 * strength rules (backend/src/services/passwordPolicy.js).
 *
 * Covers:
 *   - the policy service itself (getPolicy / checkPasswordStrength)
 *   - GET /api/auth/password-policy — the published policy the frontend
 *     derives its validation from
 *   - route-level enforcement: /register and /reset-password must reject
 *     passwords that miss the full policy (not just the 8-char minimum)
 */

jest.mock('../db');
jest.mock('../services/stellar');
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/email', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const db = require('../db');
const authRouter = require('../routes/auth');
const { getPolicy, checkPasswordStrength } = require('../services/passwordPolicy');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use((err, req, res) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const COMPLIANT_PASSWORD = 'Passw0rd!';
const WEAK_PASSWORD = 'password'; // 8 chars, but no uppercase/digit/special

describe('passwordPolicy service', () => {
  beforeEach(() => {
    delete process.env.PASSWORD_MIN_LENGTH;
  });

  test('getPolicy returns the default policy shape', () => {
    const policy = getPolicy();
    expect(policy).toEqual({
      min_length: 8,
      rules: {
        uppercase: true,
        lowercase: true,
        number: true,
        special: true,
      },
    });
  });

  test('getPolicy honors the PASSWORD_MIN_LENGTH env override', () => {
    process.env.PASSWORD_MIN_LENGTH = '10';
    expect(getPolicy().min_length).toBe(10);
    expect(checkPasswordStrength('Passw0rd!')).toContain('at least 10 characters');
  });

  test('checkPasswordStrength returns no unmet requirements for a compliant password', () => {
    expect(checkPasswordStrength(COMPLIANT_PASSWORD)).toEqual([]);
  });

  test('checkPasswordStrength flags each missing requirement', () => {
    const unmet = checkPasswordStrength(WEAK_PASSWORD);
    expect(unmet).toEqual(
      expect.arrayContaining([
        'at least one uppercase letter',
        'at least one digit',
        'at least one special character',
      ])
    );
    expect(unmet).not.toContain('at least 8 characters');
  });

  test('checkPasswordStrength flags short passwords', () => {
    expect(checkPasswordStrength('Ab1!')).toEqual(['at least 8 characters']);
  });
});

describe('GET /api/auth/password-policy', () => {
  test('serves the exact policy the backend enforces', async () => {
    const res = await request(app).get('/api/auth/password-policy');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(getPolicy());
  });
});

describe('route-level password policy enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
  });

  test('/register rejects a password that misses the full policy', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ full_name: 'Alice', email: 'alice@example.com', password: WEAK_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].msg).toMatch(/Password does not meet requirements/);
  });

  test('/reset-password enforces the full policy, not just the 8-char minimum', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'some-token', password: WEAK_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].msg).toMatch(/Password does not meet requirements/);
  });

  test('/reset-password passes validation for a compliant password', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'some-token', password: COMPLIANT_PASSWORD });

    // Validation passed — the request reached the controller, which rejects
    // the (unknown) reset token with its own 400, not a validation error.
    expect(res.status).toBe(400);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.error).toBe('Invalid or expired reset token');
  });
});
