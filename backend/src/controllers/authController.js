const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { createWallet } = require('../services/stellar');
const { hashPIN, comparePIN, validatePIN } = require('../services/pin');
const { sendVerificationEmail } = require('../services/email');
const logger = require('../utils/logger');
const {
  COOKIE_NAME,
  COOKIE_OPTIONS,
  signAccessToken,
  generateRefreshToken,
  refreshTokenExpiresAt,
} = require('../utils/tokens');

const TOKEN_TTL_MS = 96 * 60 * 60 * 1000; // 96 hours

function generateVerificationToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

async function register(req, res, next) {
  try {
    const { full_name, email, password, phone } = req.body;

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    const { raw, hashed } = generateVerificationToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    const { publicKey, encryptedSecretKey } = await createWallet();

    await db.query('BEGIN');
    await db.query(
      `INSERT INTO users (id, full_name, email, password_hash, phone, email_verified, verification_token, token_expires_at)
       VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7)`,
      [userId, full_name, email, passwordHash, phone || null, hashed, expiresAt]
    );
    await db.query(
      `INSERT INTO wallets (id, user_id, public_key, encrypted_secret_key) VALUES ($1,$2,$3,$4)`,
      [uuidv4(), userId, publicKey, encryptedSecretKey]
    );
    await db.query('COMMIT');

    await sendVerificationEmail(email, raw);

    res.status(201).json({ message: 'Account created. Please verify your email before logging in.' });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const result = await db.query(
      `SELECT u.id, u.full_name, u.email, u.password_hash, u.email_verified, u.role, w.public_key
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.email = $1`,
      [email]
    );

    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in.' });
    }

    // Short-lived access token
    const token = signAccessToken({ userId: user.id, email: user.email, role: user.role });

    // Refresh token — store only the hash, seed a new family
    const { raw, hash } = generateRefreshToken();
    const familyId = uuidv4();
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, revoked, expires_at)
       VALUES ($1, $2, $3, $4, FALSE, $5)`,
      [uuidv4(), user.id, hash, familyId, refreshTokenExpiresAt()]
    );

    res.cookie(COOKIE_NAME, raw, COOKIE_OPTIONS);
    res.json({
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email, wallet_address: user.public_key }
    });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const raw = req.cookies?.[COOKIE_NAME];
    if (!raw) return res.status(401).json({ error: 'No refresh token' });

    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    // Look up the token (active or revoked — we need both cases)
    const result = await db.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.family_id, rt.revoked,
              u.email, u.role
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [hash]
    );

    const record = result.rows[0];

    if (!record) {
      // Hash not in DB at all — could be a completely bogus token, or a token
      // from a family that was already fully wiped by a prior reuse detection.
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    if (record.revoked) {
      // Token was already rotated — this is a reuse attack.
      // Invalidate the entire family and force re-login.
      await db.query('DELETE FROM refresh_tokens WHERE family_id = $1', [record.family_id]);
      logger.warn('refresh_token_reuse detected — family invalidated', {
        event:     'refresh_token_reuse',
        family_id: record.family_id,
        user_id:   record.user_id,
      });
      res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
      return res.status(401).json({ error: 'Refresh token reuse detected. Please log in again.' });
    }

    if (new Date(record.expires_at) < new Date()) {
      await db.query('DELETE FROM refresh_tokens WHERE id = $1', [record.id]);
      res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    // Valid — rotate: mark old token revoked (kept for reuse detection), issue new one
    const { raw: newRaw, hash: newHash } = generateRefreshToken();

    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [record.id]);
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, revoked, expires_at)
       VALUES ($1, $2, $3, $4, FALSE, $5)`,
      [uuidv4(), record.user_id, newHash, record.family_id, refreshTokenExpiresAt()]
    );

    const token = signAccessToken({ userId: record.user_id, email: record.email, role: record.role });

    res.cookie(COOKIE_NAME, newRaw, COOKIE_OPTIONS);
    res.json({ token });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const raw = req.cookies?.[COOKIE_NAME];
    if (raw) {
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      // Delete the whole family so all sessions on this device are cleared
      const found = await db.query(
        'SELECT family_id FROM refresh_tokens WHERE token_hash = $1',
        [hash]
      );
      if (found.rows[0]) {
        await db.query('DELETE FROM refresh_tokens WHERE family_id = $1', [found.rows[0].family_id]);
      }
    }
    res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

async function verifyEmail(req, res, next) {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Verification token is required' });

    const hashed = crypto.createHash('sha256').update(token).digest('hex');

    const result = await db.query(
      `SELECT id, token_expires_at FROM users WHERE verification_token = $1`,
      [hashed]
    );

    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid verification token' });
    if (new Date(user.token_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Verification token has expired' });
    }

    await db.query(
      `UPDATE users SET email_verified = TRUE, verification_token = NULL, token_expires_at = NULL WHERE id = $1`,
      [user.id]
    );

    res.json({ message: 'Email verified successfully. You can now log in.' });
  } catch (err) {
    next(err);
  }
}

async function getMe(req, res, next) {
  try {
    const result = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.pin_setup_completed, w.public_key
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = result.rows[0];
    res.json({
      id: u.id,
      full_name: u.full_name,
      email: u.email,
      phone: u.phone,
      wallet_address: u.public_key,
      pin_setup_completed: u.pin_setup_completed
    });
  } catch (err) {
    next(err);
  }
}

async function setPIN(req, res, next) {
  try {
    const { pin } = req.body;
    const userId = req.user.userId;

    if (!validatePIN(pin)) {
      return res.status(400).json({ error: 'PIN must be 4-6 digits' });
    }

    const pinHash = await hashPIN(pin);
    await db.query(
      `UPDATE users SET pin_hash = $1, pin_setup_completed = true WHERE id = $2`,
      [pinHash, userId]
    );

    res.json({ message: 'PIN set successfully' });
  } catch (err) {
    next(err);
  }
}

async function verifyPIN(req, res, next) {
  try {
    const { pin } = req.body;
    const userId = req.user.userId;

    const result = await db.query(`SELECT pin_hash FROM users WHERE id = $1`, [userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });

    const { pin_hash } = result.rows[0];
    if (!pin_hash) {
      return res.status(400).json({ error: 'PIN not configured. Please set up a PIN first.' });
    }

    const isPINValid = await comparePIN(pin, pin_hash);
    if (!isPINValid) return res.status(401).json({ error: 'Invalid PIN' });

    res.json({ message: 'PIN verified successfully' });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, refresh, logout, verifyEmail, getMe, setPIN, verifyPIN };
