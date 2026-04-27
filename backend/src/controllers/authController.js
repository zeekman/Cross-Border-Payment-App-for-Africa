const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { createWallet, encryptPrivateKey, addTrustline } = require('../services/stellar');
const audit = require('../services/audit');
const logger = require('../utils/logger');
const { hashPIN, comparePIN, validatePIN } = require('../services/pin');
const { sendVerificationEmail } = require('../services/email');
const logger = require('../utils/logger');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/email');
const { generateSecret, verifyToken, generateBackupCodes, useBackupCode } = require('../services/twofa');
const {
  COOKIE_NAME,
  COOKIE_OPTIONS,
  signAccessToken,
  generateRefreshToken,
  refreshTokenExpiresAt,
} = require('../utils/tokens');
const { sendOTP } = require('../services/sms');
const { recordSession } = require('./sessionController');

const TOKEN_TTL_MS = 96 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const PHONE_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

const FORGOT_PASSWORD_MESSAGE = {
  message:
    'If an account exists for this email, you will receive password reset instructions shortly.',
};

function generateVerificationToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

function generatePhoneOTP() {
  const raw = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

const TRUSTLINE_RETRY_DELAYS_MS = [30_000, 120_000, 300_000]; // 30s, 2m, 5m

function scheduleTrustlineRetry({ publicKey, encryptedSecretKey, userId }, attempt = 0) {
  if (attempt >= TRUSTLINE_RETRY_DELAYS_MS.length) {
    logger.warn('USDC trustline retry exhausted', { userId });
    return;
  }
  setTimeout(async () => {
    try {
      await addTrustline({ publicKey, encryptedSecretKey, asset: 'USDC' });
      logger.info('USDC trustline retry succeeded', { userId, attempt });
    } catch (e) {
      logger.warn('USDC trustline retry failed', { userId, attempt, error: e.message });
      scheduleTrustlineRetry({ publicKey, encryptedSecretKey, userId }, attempt + 1);
    }
  }, TRUSTLINE_RETRY_DELAYS_MS[attempt]);
}

async function register(req, res, next) {
  try {
    const { full_name, email, password, phone, secret_key: importedSecretKey, referral_code: referredBy } = req.body;

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    const { raw, hashed } = generateVerificationToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    // Generate unique referral code for this user
    const myReferralCode = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10-char hex

    // Validate referred_by code if provided
    let validReferredBy = null;
    if (referredBy) {
      const ref = await db.query('SELECT id FROM users WHERE referral_code = $1', [referredBy]);
      if (ref.rows.length > 0) validReferredBy = referredBy;
    }

    let publicKey, encryptedSecretKey;
    if (importedSecretKey) {
      // Validate and import existing Stellar keypair
      const StellarSdk = require('@stellar/stellar-sdk');
      if (!StellarSdk.StrKey.isValidEd25519SecretSeed(importedSecretKey)) {
        return res.status(400).json({ error: 'Invalid Stellar secret key' });
      }
      const keypair = StellarSdk.Keypair.fromSecret(importedSecretKey);
      publicKey = keypair.publicKey();
      encryptedSecretKey = encryptPrivateKey(importedSecretKey);
    } else {
      ({ publicKey, encryptedSecretKey } = await createWallet());
    }

    const { raw: otpRaw, hashed: otpHashed } = phone ? generatePhoneOTP() : { raw: null, hashed: null };
    const otpExpiresAt = phone ? new Date(Date.now() + PHONE_OTP_TTL_MS) : null;

    await db.query('BEGIN');
    await db.query(
      `INSERT INTO users (id, full_name, email, password_hash, phone, email_verified, verification_token, token_expires_at, phone_verified, phone_otp_hash, phone_otp_expires_at)
       VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7,FALSE,$8,$9)`,
      [userId, full_name, email, passwordHash, phone || null, hashed, expiresAt, otpHashed, otpExpiresAt]
    );
    await db.query(
      `INSERT INTO wallets (id, user_id, public_key, encrypted_secret_key) VALUES ($1,$2,$3,$4)`,
      [uuidv4(), userId, publicKey, encryptedSecretKey]
    );
    await db.query('COMMIT');

    // Auto-add USDC trustline so new accounts can receive USDC immediately
    let trustline_status = 'skipped';
    if (process.env.USDC_ISSUER) {
      try {
        await addTrustline({ publicKey, encryptedSecretKey, asset: 'USDC' });
        trustline_status = 'active';
      } catch (e) {
        trustline_status = 'pending';
        logger.warn('Auto USDC trustline failed', { userId, error: e.message });
        scheduleTrustlineRetry({ publicKey, encryptedSecretKey, userId });
      }
    }

    await sendVerificationEmail(email, raw);
    if (phone && otpRaw) {
      sendOTP(phone, otpRaw).catch(e => logger.warn('Registration OTP SMS failed', { error: e.message }));
    }
    res.status(201).json({
      message: 'Account created. Please verify your email and phone number.',
      trustline_status,
    });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password, totp_code } = req.body;

    const result = await db.query(
      `SELECT u.id, u.full_name, u.email, u.password_hash, u.email_verified, u.role, u.totp_enabled, u.totp_secret, u.failed_login_attempts, u.locked_until, w.public_key
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.email = $1`,
      [email]
    );

    const user = result.rows[0];
    const now = new Date();

    if (user && user.locked_until) {
      const lockUntil = new Date(user.locked_until);
      if (now < lockUntil) {
        return res.status(423).json({
          error: `Account locked until ${lockUntil.toISOString()}`,
        });
      }

      await db.query(
        `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
        [user.id]
      );
      user.failed_login_attempts = 0;
      user.locked_until = null;
    }

    const isValidPassword = user && (await bcrypt.compare(password, user.password_hash));
    if (!user || !isValidPassword) {
      if (user) {
        const attempts = (user.failed_login_attempts || 0) + 1;
        if (attempts >= 10) {
          const lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          await db.query(
            `UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
            [attempts, lockedUntil, user.id]
          );
          audit.log(user.id, 'login_failure', req.ip, req.headers['user-agent']);
          return res.status(423).json({
            error: `Account locked until ${lockedUntil.toISOString()}`,
          });
        }

        await db.query(
          `UPDATE users SET failed_login_attempts = $1 WHERE id = $2`,
          [attempts, user.id]
        );
        audit.log(user.id, 'login_failure', req.ip, req.headers['user-agent']);
      }

      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in.' });
    }

    // Check if 2FA is enabled
    if (user.totp_enabled) {
      if (!totp_code) {
        return res.status(403).json({ error: 'TOTP code required', requires_2fa: true });
      }

      const isValid = verifyToken(user.totp_secret, totp_code);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    }

    await db.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [user.id]
    );

    const token = signAccessToken({ userId: user.id, email: user.email, role: user.role });

    // Issue refresh token — store only the hash in DB, seed a new family
    const { raw, hash } = generateRefreshToken();
    const expiresAt = refreshTokenExpiresAt();
    const familyId = uuidv4();
    const { raw, hash } = generateRefreshToken();
    const expiresAt = refreshTokenExpiresAt();
    
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, family_id, revoked)
       VALUES ($1, $2, $3, $4, $5, FALSE)`,
      [uuidv4(), user.id, hash, expiresAt, familyId]
    );

    // Record session for remote logout support
    await recordSession(user.id, token, req).catch(() => {});

    res.cookie(COOKIE_NAME, raw, COOKIE_OPTIONS);
    audit.log(user.id, 'login_success', req.ip, req.headers['user-agent']);
    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        wallet_address: user.public_key,
        phone_verified: user.phone_verified,
      },
    });
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

async function verifyPhone(req, res, next) {
  try {
    const { otp } = req.body;
    const userId = req.user.userId;

    if (!otp) return res.status(400).json({ error: 'OTP is required' });

    const hashed = crypto.createHash('sha256').update(otp).digest('hex');

    const result = await db.query(
      `SELECT phone_otp_hash, phone_otp_expires_at, phone FROM users WHERE id = $1`,
      [userId]
    );

    const user = result.rows[0];
    if (!user || user.phone_otp_hash !== hashed) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    if (new Date(user.phone_otp_expires_at) < new Date()) {
      return res.status(400).json({ error: 'OTP has expired' });
    }

    await db.query(
      `UPDATE users SET phone_verified = TRUE, phone_otp_hash = NULL, phone_otp_expires_at = NULL WHERE id = $1`,
      [userId]
    );

    audit.log(userId, 'phone_verified', req.ip, req.headers['user-agent']);
    res.json({ message: 'Phone number verified successfully.' });
  } catch (err) {
    next(err);
  }
}

async function getMe(req, res, next) {
  try {
    const result = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.phone_verified, u.pin_setup_completed, u.totp_enabled, u.account_type, w.public_key
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
      phone_verified: u.phone_verified,
      wallet_address: u.public_key,
      pin_setup_completed: u.pin_setup_completed,
      totp_enabled: u.totp_enabled,
      account_type: u.account_type,
    });
  } catch (err) {
    next(err);
  }
}

async function setup2FA(req, res, next) {
  try {
    const userId = req.user.userId;
    const user = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });

    const { secret, qrCode } = await generateSecret(user.rows[0].email);
    const backupCodes = generateBackupCodes();

    // Store temporarily (not enabled yet)
    await db.query(
      `UPDATE users SET totp_secret = $1, backup_codes = $2 WHERE id = $3`,
      [secret, backupCodes, userId]
    );

    res.json({ qrCode, backupCodes, secret });
  } catch (err) {
    next(err);
  }
}

async function verify2FA(req, res, next) {
  try {
    const { totp_code } = req.body;
    const userId = req.user.userId;

    const user = await db.query('SELECT totp_secret FROM users WHERE id = $1', [userId]);
    if (!user.rows[0] || !user.rows[0].totp_secret) {
      return res.status(400).json({ error: '2FA setup not initiated' });
    }

    const isValid = verifyToken(user.rows[0].totp_secret, totp_code);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid TOTP code' });
    }

    await db.query(
      `UPDATE users SET totp_enabled = TRUE WHERE id = $1`,
      [userId]
    );

    audit.log(userId, '2fa_enabled', req.ip, req.headers['user-agent']);
    res.json({ message: '2FA enabled successfully' });
  } catch (err) {
    next(err);
  }
}

async function disable2FA(req, res, next) {
  try {
    const { password } = req.body;
    const userId = req.user.userId;

    const user = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!user.rows[0] || !(await bcrypt.compare(password, user.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    await db.query(
      `UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, backup_codes = NULL WHERE id = $1`,
      [userId]
    );

    audit.log(userId, '2fa_disabled', req.ip, req.headers['user-agent']);
    res.json({ message: '2FA disabled' });
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
    await db.query(`UPDATE users SET pin_hash = $1, pin_setup_completed = true WHERE id = $2`, [
      pinHash,
      userId,
    ]);

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

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { pin_hash } = result.rows[0];

    if (!pin_hash) {
      return res.status(400).json({ error: 'PIN not configured. Please set up a PIN first.' });
    }

    const isPINValid = await comparePIN(pin, pin_hash);
    if (!isPINValid) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    res.json({ message: 'PIN verified successfully' });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const raw = req.cookies?.[COOKIE_NAME];
    if (!raw) return res.status(401).json({ error: 'No refresh token' });

    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    // Look up the token — active (not revoked) and not expired
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
      // Token hash unknown — could be a completely invalid token (ignore)
      // or a previously-rotated token being replayed (reuse attack).
      // Check if this hash belongs to a revoked token in any known family.
      const revokedResult = await db.query(
        `SELECT rt.family_id, rt.user_id
         FROM refresh_tokens rt
         WHERE rt.token_hash = $1 AND rt.revoked = TRUE`,
        [hash]
      );

      if (revokedResult.rows.length > 0) {
        // Reuse detected — invalidate the entire family and force re-login
        const { family_id, user_id } = revokedResult.rows[0];
        await db.query(
          'DELETE FROM refresh_tokens WHERE family_id = $1',
          [family_id]
        );
        logger.warn('refresh_token_reuse detected — family invalidated', {
          event: 'refresh_token_reuse',
          family_id,
          user_id,
        });
        res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
        return res.status(401).json({ error: 'Refresh token reuse detected. Please log in again.' });
      }

      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    if (record.revoked) {
      // Active lookup returned a revoked row — same family attack, nuke family
      await db.query(
        'DELETE FROM refresh_tokens WHERE family_id = $1',
        [record.family_id]
      );
      logger.warn('refresh_token_reuse detected — family invalidated', {
        event: 'refresh_token_reuse',
        family_id: record.family_id,
        user_id: record.user_id,
      });
      res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
      return res.status(401).json({ error: 'Refresh token reuse detected. Please log in again.' });
    }

    if (new Date(record.expires_at) < new Date()) {
      // Expired — clean up this token only (family may have other valid tokens)
      await db.query('DELETE FROM refresh_tokens WHERE id = $1', [record.id]);
      res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    // Valid — rotate: mark old token revoked (kept for reuse detection), issue new one
    const { raw: newRaw, hash: newHash } = generateRefreshToken();
    const expiresAt = refreshTokenExpiresAt();

    await db.query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1',
      [record.id]
    );
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, family_id, revoked)
       VALUES ($1, $2, $3, $4, $5, FALSE)`,
      [uuidv4(), record.user_id, newHash, expiresAt, record.family_id]
    );

    const token = signAccessToken({
      userId: record.user_id,
      email: record.email,
      role: record.role,
    });

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
      await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);
    }
    res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

async function forgotPassword(req, res, next) {
  try {
    const email = req.body.email;
    const found = await db.query('SELECT id FROM users WHERE email = $1', [email]);

    // Respond immediately regardless of whether the email exists.
    // All DB writes and email sending happen asynchronously after the response,
    // so both code paths return at the same time (no timing-based enumeration).
    res.status(200).json(FORGOT_PASSWORD_MESSAGE);

    if (found.rows.length === 0) return;

    const userId = found.rows[0].id;
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    // Fire-and-forget: errors are swallowed to avoid leaking info via error responses
    Promise.resolve()
      .then(() => db.query('DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL', [userId]))
      .then(() => db.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
        [userId, tokenHash, expiresAt]
      ))
      .then(() => sendPasswordResetEmail(email, raw))
      .catch((err) => logger.warn('forgotPassword background task failed', { error: err.message }));
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Reset token is required' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const found = await db.query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );

    if (found.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const { user_id: userId } = found.rows[0];
    const passwordHash = await bcrypt.hash(password, 12);

    await db.query('BEGIN');
    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
    await db.query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );
    await db.query('COMMIT');

    audit.log(userId, 'password_change', req.ip, req.headers['user-agent']);
    res.json({ message: 'Password has been reset. You can now log in.' });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const { full_name, phone } = req.body;
    const userId = req.user.userId;

    const oldUserResult = await db.query('SELECT phone FROM users WHERE id = $1', [userId]);
    const oldPhone = oldUserResult.rows[0]?.phone;

    let phoneVerified = undefined;
    let otpHashed = undefined;
    let otpExpiresAt = undefined;
    let otpRaw = undefined;

    if (phone && phone !== oldPhone) {
      ({ raw: otpRaw, hashed: otpHashed } = generatePhoneOTP());
      otpExpiresAt = new Date(Date.now() + PHONE_OTP_TTL_MS);
      phoneVerified = false;
    }

    await db.query(
      `UPDATE users SET
        full_name = COALESCE($1, full_name),
        phone = COALESCE($2, phone),
        phone_verified = COALESCE($3, phone_verified),
        phone_otp_hash = COALESCE($4, phone_otp_hash),
        phone_otp_expires_at = COALESCE($5, phone_otp_expires_at)
      WHERE id = $6`,
      [full_name || null, phone || null, phoneVerified, otpHashed, otpExpiresAt, userId]
    );

    if (otpRaw && phone) {
      sendOTP(phone, otpRaw).catch(e => logger.warn('Profile update OTP SMS failed', { error: e.message }));
    }

    audit.log(userId, 'profile_update', req.ip, req.headers['user-agent']);
    res.json({
      message: 'Profile updated',
      phone_verification_required: !!otpRaw
    });
  } catch (err) {
    next(err);
  }
}

async function getActivity(req, res, next) {
  try {
    const result = await db.query(
      `SELECT action, ip_address, user_agent, metadata, created_at
       FROM audit_logs WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.userId]
    );
    res.json({ activity: result.rows });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  verifyEmail,
  verifyPhone,
  getMe,
  updateProfile,
  getActivity,
  setPIN,
  verifyPIN,
  setup2FA,
  verify2FA,
  disable2FA,
  forgotPassword,
  resetPassword,
};
