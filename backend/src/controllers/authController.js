const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { createWallet, encryptPrivateKey, addTrustline } = require('../services/stellar');
const audit = require('../services/audit');
const logger = require('../utils/logger');
const { hashPIN, comparePIN, validatePIN } = require('../services/pin');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/email');
const { generateSecret, verifyToken, generateBackupCodes, useBackupCode } = require('../services/twofa');
const { sendVerificationEmail, sendPasswordResetEmail, sendBackupCodeWarningEmail, sendEmailChangeRequestedNotice } = require('../services/email');
const { generateSecret, verifyToken, getTokenCounter, generateBackupCodes, useBackupCode, hashBackupCode, verifyBackupCode } = require('../services/twofa');
const {
  COOKIE_NAME,
  COOKIE_OPTIONS,
  DEVICE_COOKIE_NAME,
  DEVICE_COOKIE_OPTIONS,
  signAccessToken,
  generateRefreshToken,
  refreshTokenExpiresAt,
  signDeviceToken,
  verifyDeviceToken,
} = require('../utils/tokens');
const { setCsrfCookie } = require('../middleware/csrf');
const cache = require('../utils/cache');
const { encryptSecret, decryptSecret } = require('../utils/symmetricEncryption');
const {
  getRpConfig,
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('../services/webauthn');

const { sendOTP } = require('../services/sms');
const { recordSession, invalidateOtherSessions } = require('./sessionController');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — email verification tokens
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const PHONE_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const WEBAUTHN_CHALLENGE_TTL_SECONDS = 5 * 60; // 5 minutes
const LOCKOUT_DURATION_MINUTES = 15;
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MINUTES = 15;

const FORGOT_PASSWORD_MESSAGE = {
  message:
    'If an account exists for this email, you will receive password reset instructions shortly.',
};

async function recordFailedAuthAttempt(userId, req) {
  const attemptWindowMs = ATTEMPT_WINDOW_MINUTES * 60 * 1000;
  const lockoutDurationMs = LOCKOUT_DURATION_MINUTES * 60 * 1000;
  const result = await db.query(
    `UPDATE users
     SET failed_login_attempts = CASE
       WHEN last_failed_attempt_at IS NULL
            OR (EXTRACT(EPOCH FROM (NOW() - last_failed_attempt_at)) * 1000) > $1
       THEN 1 ELSE failed_login_attempts + 1 END,
       last_failed_attempt_at = NOW(),
       locked_until = CASE
         WHEN (CASE
           WHEN last_failed_attempt_at IS NULL
                OR (EXTRACT(EPOCH FROM (NOW() - last_failed_attempt_at)) * 1000) > $1
           THEN 1 ELSE failed_login_attempts + 1 END) >= $2
         THEN NOW() + ($3 * INTERVAL '1 millisecond')
         ELSE locked_until END
     WHERE id = $4
     RETURNING failed_login_attempts, locked_until`,
    [attemptWindowMs, MAX_FAILED_ATTEMPTS, lockoutDurationMs, userId]
  );
  const updated = result.rows[0];
  if (!updated) return null;
  audit.log(userId, 'login_failure', req.ip, req.headers['user-agent'], {
    failed_attempts: updated.failed_login_attempts,
    attempts_remaining: Math.max(0, MAX_FAILED_ATTEMPTS - updated.failed_login_attempts),
    reason: 'invalid_2fa',
  });
  return updated;
}

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

/** Strip HTML tags and limit length for safe storage */
function sanitizeFullName(value) {
  if (typeof value !== 'string') return '';
  // Remove any HTML/script tags
  return value.replace(/<[^>]*>/g, '').trim().slice(0, 100);
}

/** Validate E.164 phone format: +[country code][number], 8–15 digits total */
function isValidE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

async function register(req, res, next) {
  try {
    const { full_name: rawFullName, email, password, phone, secret_key: importedSecretKey, referral_code: referredBy } = req.body;

    // Sanitize and validate inputs
    const full_name = sanitizeFullName(rawFullName);
    if (!full_name) {
      return res.status(400).json({ error: 'full_name is required', field: 'full_name' });
    }
    if (phone && !isValidE164(phone)) {
      return res.status(400).json({ error: 'phone must be a valid E.164 number (e.g. +2348012345678)', field: 'phone' });
    }

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

    // Acquire a dedicated client so BEGIN/COMMIT are scoped to a single connection.
    // If the wallet INSERT fails the ROLLBACK will undo the user INSERT too.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id, full_name, email, password_hash, phone, email_verified, verification_token, token_expires_at, phone_verified, phone_otp_hash, phone_otp_expires_at)
         VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7,FALSE,$8,$9)`,
        [userId, full_name, email, passwordHash, phone || null, hashed, expiresAt, otpHashed, otpExpiresAt]
      );
      await client.query(
        `INSERT INTO wallets (id, user_id, public_key, encrypted_secret_key) VALUES ($1,$2,$3,$4)`,
        [uuidv4(), userId, publicKey, encryptedSecretKey]
      );
      await client.query('COMMIT');
    } catch (clientErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw clientErr;
    } finally {
      client.release();
    }

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
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password, totp_code, rememberDevice } = req.body;
    // Device-trust token now travels as an httpOnly cookie (issue #995), not a
    // client-readable header/localStorage value. Header kept as a legacy fallback
    // for callers that haven't migrated yet.
    const incomingDeviceToken = req.cookies?.[DEVICE_COOKIE_NAME] || req.headers['x-device-token'];

    const result = await db.query(
      `SELECT u.id, u.full_name, u.email, u.password_hash, u.email_verified, u.role,
              u.totp_enabled, u.totp_secret, u.failed_login_attempts, u.locked_until,
              u.last_failed_attempt_at, u.onboarding_completed, u.is_suspended, 
              u.suspension_reason, w.public_key
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.email = $1`,
      [email]
    );

    const user = result.rows[0];
    const now = new Date();
    
    // Check if account is suspended
    if (user && user.is_suspended) {
      return res.status(403).json({
        error: 'Account suspended',
        reason: user.suspension_reason || 'Your account has been suspended. Please contact support.',
        code: 'ACCOUNT_SUSPENDED'
      });
    }
    
    // Lockout configuration — single source of truth for threshold and windows
    const LOCKOUT_DURATION_MINUTES = 15;
    const MAX_FAILED_ATTEMPTS = 5;
    const ATTEMPT_WINDOW_MINUTES = 15;

    // Check if account is currently locked
    if (user && user.locked_until) {
      const lockUntil = new Date(user.locked_until);
      if (now < lockUntil) {
        return res.status(423).json({
          error: `Account locked. Try again after ${lockUntil.toISOString()}`,
          locked_until: lockUntil.toISOString(),
        });
      }
      // Lock has expired — reset counters atomically before proceeding
      await db.query(
        `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_failed_attempt_at = NULL WHERE id = $1`,
        [user.id]
      );
      user.failed_login_attempts = 0;
      user.locked_until = null;
      user.last_failed_attempt_at = null;
    }

    // Verify password
    const isValidPassword = user && (await bcrypt.compare(password, user.password_hash));
    if (!user || !isValidPassword) {
      if (user) {
        // Atomic increment: use a single UPDATE...RETURNING so concurrent failed
        // logins on the same account never lose an increment (fixes #954).
        // If the last attempt was outside the window, reset the counter to 1
        // atomically in the same statement.
        const ATTEMPT_WINDOW_MS = ATTEMPT_WINDOW_MINUTES * 60 * 1000;
        const lockoutDurationMs = LOCKOUT_DURATION_MINUTES * 60 * 1000;

        const atomicResult = await db.query(
          `UPDATE users
           SET
             failed_login_attempts = CASE
               WHEN last_failed_attempt_at IS NULL
                    OR (EXTRACT(EPOCH FROM (NOW() - last_failed_attempt_at)) * 1000) > $1
               THEN 1
               ELSE failed_login_attempts + 1
             END,
             last_failed_attempt_at = NOW(),
             locked_until = CASE
               WHEN (
                 CASE
                   WHEN last_failed_attempt_at IS NULL
                        OR (EXTRACT(EPOCH FROM (NOW() - last_failed_attempt_at)) * 1000) > $1
                   THEN 1
                   ELSE failed_login_attempts + 1
                 END
               ) >= $2
               THEN NOW() + ($3 * INTERVAL '1 millisecond')
               ELSE locked_until
             END
           WHERE id = $4
           RETURNING failed_login_attempts, locked_until`,
          [ATTEMPT_WINDOW_MS, MAX_FAILED_ATTEMPTS, lockoutDurationMs, user.id]
        );

        const updated = atomicResult.rows[0];
        const failedAttempts = updated.failed_login_attempts;

        if (updated.locked_until && new Date(updated.locked_until) > now) {
          audit.log(user.id, 'account_locked', req.ip, req.headers['user-agent'], {
            reason: 'excessive_failed_login_attempts',
            attempts: failedAttempts,
            locked_until: new Date(updated.locked_until).toISOString(),
          });
          return res.status(423).json({
            error: `Account locked due to too many failed login attempts. Try again after ${new Date(updated.locked_until).toISOString()}`,
            locked_until: new Date(updated.locked_until).toISOString(),
          });
        }

        audit.log(user.id, 'login_failure', req.ip, req.headers['user-agent'], {
          failed_attempts: failedAttempts,
          attempts_remaining: MAX_FAILED_ATTEMPTS - failedAttempts,
        });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in.' });
    }

    // Check if 2FA is enabled
    if (user.totp_enabled) {
      const { totp_code: totpCode, backup_code } = req.body;

      // Backup codes can be used in place of TOTP
      if (backup_code) {
        const codes = await db.query(
          `SELECT id, code_hash FROM totp_backup_codes WHERE user_id = $1 AND used_at IS NULL`,
          [user.id]
        );
        let matchedId = null;
        for (const row of codes.rows) {
          if (await verifyBackupCode(backup_code, row.code_hash)) {
            matchedId = row.id;
            break;
          }
        }
        if (!matchedId) {
          const failed = await recordFailedAuthAttempt(user.id, req);
          if (failed?.locked_until && new Date(failed.locked_until) > new Date()) {
            return res.status(423).json({
              error: `Account locked due to too many failed login attempts. Try again after ${new Date(failed.locked_until).toISOString()}`,
              locked_until: new Date(failed.locked_until).toISOString(),
            });
          }
          return res.status(401).json({ error: 'Invalid backup code' });
        }
        const consumed = await db.query(
          `UPDATE totp_backup_codes SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id`,
          [matchedId]
        );
        if (!consumed.rows.length) {
          const failed = await recordFailedAuthAttempt(user.id, req);
          if (failed?.locked_until && new Date(failed.locked_until) > new Date()) {
            return res.status(423).json({
              error: `Account locked due to too many failed login attempts. Try again after ${new Date(failed.locked_until).toISOString()}`,
              locked_until: new Date(failed.locked_until).toISOString(),
            });
          }
          return res.status(401).json({ error: 'Invalid backup code' });
        }
        const remaining = await db.query(
          `SELECT COUNT(*) AS count FROM totp_backup_codes WHERE user_id = $1 AND used_at IS NULL`,
          [user.id]
        );
        if (parseInt(remaining.rows[0].count, 10) < 3) {
          const emailRow = await db.query('SELECT email FROM users WHERE id = $1', [user.id]);
          sendBackupCodeWarningEmail(emailRow.rows[0].email, parseInt(remaining.rows[0].count, 10)).catch(() => {});
        }
      } else {
        // Device trust token allows skipping TOTP on a previously trusted device.
        let deviceTrusted = false;
        if (incomingDeviceToken) {
          try {
            const payload = verifyDeviceToken(incomingDeviceToken);
            deviceTrusted = String(payload.userId) === String(user.id);
          } catch { /* expired or invalid — require TOTP */ }
        }
        if (!deviceTrusted && !totpCode) {
          return res.status(401).json({ error: 'TOTP code required', code: 'TOTP_REQUIRED', requires_2fa: true });
        }
        if (!deviceTrusted && !verifyToken(user.totp_secret, totpCode)) {
          return res.status(401).json({ error: 'Invalid TOTP code' });
        }
      }
    }

    // Successful login — reset attempt counters
    await db.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_failed_attempt_at = NULL WHERE id = $1`,
      [user.id]
    );

    // Issue short-lived access token
    const token = signAccessToken({ userId: user.id, email: user.email, role: user.role });

    // Issue refresh token — store only the hash in DB, seed a new family
    const { raw, hash } = generateRefreshToken();
    const expiresAt = refreshTokenExpiresAt();
    const familyId = uuidv4();

    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, family_id, revoked)
       VALUES ($1, $2, $3, $4, $5, FALSE)`,
      [uuidv4(), user.id, hash, expiresAt, familyId]
    );

    // Record session for remote logout support
    await recordSession(user.id, token, req).catch(() => {});

    const device_token = rememberDevice ? signDeviceToken({ userId: user.id }) : undefined;

    res.cookie(COOKIE_NAME, raw, COOKIE_OPTIONS);
    setCsrfCookie(res);
    // Set the device-trust token as an httpOnly cookie instead of returning it in the
    // JSON body — the frontend no longer stores it in localStorage (issue #995).
    if (device_token) {
      res.cookie(DEVICE_COOKIE_NAME, device_token, DEVICE_COOKIE_OPTIONS);
    }
    setCsrfCookie(res, familyId);
    audit.log(user.id, 'login_success', req.ip, req.headers['user-agent']);
    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        wallet_address: user.public_key,
        phone_verified: user.phone_verified,
        onboarding_completed: user.onboarding_completed,
      },
    });
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
        'SELECT family_id, expires_at FROM refresh_tokens WHERE token_hash = $1',
        [hash]
      );
      if (found.rows[0]) {
        await db.query('DELETE FROM refresh_tokens WHERE family_id = $1', [found.rows[0].family_id]);
        // Blacklist in Redis so in-flight refresh attempts are rejected immediately
        const ttlSeconds = Math.max(0, Math.floor((new Date(found.rows[0].expires_at) - Date.now()) / 1000));
        if (ttlSeconds > 0) {
          await cache.set(`blacklist:rt:${hash}`, '1', ttlSeconds);
        }
      }
    }
    res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

async function resendVerification(req, res, next) {
  try {
    const { email } = req.body;
    res.status(200).json({ message: 'If that account exists and is unverified, a new verification email has been sent.' });

    const found = await db.query('SELECT id FROM users WHERE email = $1 AND email_verified = FALSE', [email]);
    if (found.rows.length === 0) return;

    const { raw, hashed } = generateVerificationToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    Promise.resolve()
      .then(() => db.query(
        'UPDATE users SET verification_token = $1, token_expires_at = $2 WHERE id = $3',
        [hashed, expiresAt, found.rows[0].id]
      ))
      .then(() => sendVerificationEmail(email, raw))
      .catch((err) => logger.warn('resendVerification background task failed', { error: err.message }));
  } catch (err) {
    next(err);
  }
}

async function verifyEmail(req, res, next) {
  try {
    // Prefer POST body; query-string GET is deprecated (tokens in URLs leak via logs/Referer)
    const token = req.body?.token || req.query.token;
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
      `SELECT u.id, u.full_name, u.email, u.email_verified, u.phone, u.phone_verified, u.pin_setup_completed, u.totp_enabled, u.account_type, u.avatar_url, u.onboarding_completed, w.public_key
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
      email_verified: u.email_verified,
      phone: u.phone,
      phone_verified: u.phone_verified,
      wallet_address: u.public_key,
      pin_setup_completed: u.pin_setup_completed,
      totp_enabled: u.totp_enabled,
      account_type: u.account_type,
      avatar_url: u.avatar_url || null,
      onboarding_completed: u.onboarding_completed,
    });
  } catch (err) {
    next(err);
  }
}

async function setup2FA(req, res, next) {
  try {
    const userId = req.user.userId;
    const user = await db.query('SELECT email, totp_enabled FROM users WHERE id = $1', [userId]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });

    // Issue #1151: Prevent silently replacing an active 2FA secret.
    // If the user already has 2FA enabled, they must first disable it
    // (verify2FADisable) before setting up a new secret.
    if (user.rows[0].totp_enabled) {
      return res.status(400).json({
        error: '2FA is already enabled on this account. Please disable it first if you need to set up a new authenticator.',
        code: 'TOTP_ALREADY_ENABLED',
      });
    }

    const { secret, qrCode, otpauthUri } = await generateSecret(user.rows[0].email);
    const backupCodes = generateBackupCodes();

    // Store temporarily (not enabled yet)
    await db.query(
      `UPDATE users SET totp_secret = $1, backup_codes = $2 WHERE id = $3`,
      [secret, backupCodes, userId]
    );

    res.json({ qrCode, backupCodes, secret, otpauthUri });
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

    await db.query(`UPDATE users SET totp_enabled = TRUE WHERE id = $1`, [userId]);

    const rawCodes = generateBackupCodes(10);
    await db.query(`DELETE FROM totp_backup_codes WHERE user_id = $1`, [userId]);
    for (const code of rawCodes) {
      const hash = await hashBackupCode(code);
      await db.query(
        `INSERT INTO totp_backup_codes (user_id, code_hash) VALUES ($1, $2)`,
        [userId, hash]
      );
    }

    audit.log(userId, '2fa_enabled', req.ip, req.headers['user-agent']);
    res.json({ message: '2FA enabled successfully', backup_codes: rawCodes });
  } catch (err) {
    next(err);
  }
}

async function regenerateBackupCodes(req, res, next) {
  try {
    const { totp_code } = req.body;
    const userId = req.user.userId;

    const user = await db.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [userId]);
    if (!user.rows[0]?.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }
    if (!verifyToken(user.rows[0].totp_secret, totp_code)) {
      return res.status(401).json({ error: 'Invalid TOTP code' });
    }

    const rawCodes = generateBackupCodes(10);
    await db.query(`DELETE FROM totp_backup_codes WHERE user_id = $1`, [userId]);
    for (const code of rawCodes) {
      const hash = await hashBackupCode(code);
      await db.query(
        `INSERT INTO totp_backup_codes (user_id, code_hash) VALUES ($1, $2)`,
        [userId, hash]
      );
    }

    audit.log(userId, '2fa_backup_codes_regenerated', req.ip, req.headers['user-agent']);
    res.json({ backup_codes: rawCodes });
  } catch (err) {
    next(err);
  }
}

async function getBackupCodeCount(req, res, next) {
  try {
    const userId = req.user.userId;
    const result = await db.query(
      `SELECT COUNT(*) AS count FROM totp_backup_codes WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );
    res.json({ remaining: parseInt(result.rows[0].count, 10) });
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

async function registerBiometric(req, res, next) {
  try {
    const { credential_id, device_label } = req.body;
    const userId = req.user.userId;

    if (!credential_id || typeof credential_id !== 'string') {
      return res.status(400).json({ error: 'credential_id is required' });
    }

    await db.query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, device_label)
       VALUES ($1, $2, $3)
       ON CONFLICT (credential_id) DO NOTHING`,
      [userId, credential_id, device_label || null]
    );

    res.json({ message: 'Biometric credential registered successfully' });
  } catch (err) {
    next(err);
  }
}

async function getBiometricStatus(req, res, next) {
  try {
    const userId = req.user.userId;
    const result = await db.query(
      `SELECT id, credential_id, device_label, created_at, last_used_at
       FROM webauthn_credentials
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({ registered: result.rows.length > 0, credentials: result.rows });
  } catch (err) {
    next(err);
  }
}

async function disableBiometric(req, res, next) {
  try {
    const userId = req.user.userId;
    const { credential_id } = req.body;

    await db.query(
      `UPDATE webauthn_credentials
       SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL
       ${credential_id ? 'AND credential_id = $2' : ''}`,
      credential_id ? [userId, credential_id] : [userId]
    );

    res.json({ message: 'Biometric credential(s) disabled' });
  } catch (err) {
    next(err);
  }
}

// BE-137: a token rotated within this window (e.g. two tabs refreshing at
// once) returns the already-issued successor instead of counting as reuse.
const REFRESH_GRACE_MS = 20_000;

async function revokeFamilyForReuse(res, record) {
  await db.query(
    `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = COALESCE(revoked_at, NOW()), replaced_by_enc = NULL
     WHERE family_id = $1`,
    [record.family_id]
  );
  logger.warn('refresh_token_reuse detected — family revoked', {
    event: 'refresh_token_reuse',
    family_id: record.family_id,
    user_id: record.user_id,
  });
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
  return res.status(401).json({ error: 'Refresh token reuse detected. Please log in again.' });
}

function issueRefreshResponse(res, record, rawToken) {
  const token = signAccessToken({
    userId: record.user_id,
    email: record.email,
    role: record.role,
  });
  res.cookie(COOKIE_NAME, rawToken, COOKIE_OPTIONS);
  setCsrfCookie(res, record.family_id);
  return res.json({ token });
}

function withinGrace(record) {
  return (
    record.revoked_at &&
    record.replaced_by_enc &&
    Date.now() - new Date(record.revoked_at).getTime() <= REFRESH_GRACE_MS
  );
}

async function refresh(req, res, next) {
  try {
    const raw = req.cookies?.[COOKIE_NAME];
    if (!raw) return res.status(401).json({ error: 'No refresh token' });

    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    // Fast-path: check Redis blacklist (set on logout) before hitting the database
    const blacklisted = await cache.get(`blacklist:rt:${hash}`);
    if (blacklisted) {
      logger.warn('refresh_token_blacklisted — Redis fast-reject', { event: 'refresh_token_blacklisted' });
      res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
      return res.status(401).json({ error: 'Refresh token has been revoked. Please log in again.' });
    }

    const lookup = () => db.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.family_id, rt.revoked,
              rt.revoked_at, rt.replaced_by_enc, u.email, u.role
              u.email, u.role, u.is_suspended, u.suspension_reason
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [hash]
    );

    const record = (await lookup()).rows[0];
    if (!record) return res.status(401).json({ error: 'Invalid refresh token' });

    if (record.revoked) {
      if (withinGrace(record)) return issueRefreshResponse(res, record, decryptSecret(record.replaced_by_enc));
      return revokeFamilyForReuse(res, record);
    }
    
    // Check if user account is suspended
    if (record.is_suspended) {
      res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
      return res.status(403).json({
        error: 'Account suspended',
        reason: record.suspension_reason || 'Your account has been suspended. Please contact support.',
        code: 'ACCOUNT_SUSPENDED'
      });
    }

    if (new Date(record.expires_at) < new Date()) {
      // Expired — clean up this token only (family may have other valid tokens)
      await db.query('DELETE FROM refresh_tokens WHERE id = $1', [record.id]);
      res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    // Valid — rotate. Insert the successor first, then atomically claim the
    // old token; if a concurrent request won the race, hand back its successor.
    const { raw: newRaw, hash: newHash } = generateRefreshToken();
    const successorId = uuidv4();
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, family_id, revoked)
       VALUES ($1, $2, $3, $4, $5, FALSE)`,
      [successorId, record.user_id, newHash, refreshTokenExpiresAt(), record.family_id]
    );
    const claimed = await db.query(
      `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW(), replaced_by_enc = $2
       WHERE id = $1 AND revoked = FALSE
       RETURNING id`,
      [record.id, encryptSecret(newRaw)]
    );

    if (!claimed.rows.length) {
      await db.query('DELETE FROM refresh_tokens WHERE id = $1', [successorId]);
      const winner = (await lookup()).rows[0];
      if (winner && withinGrace(winner)) return issueRefreshResponse(res, winner, decryptSecret(winner.replaced_by_enc));
      return revokeFamilyForReuse(res, record);
    }

    return issueRefreshResponse(res, record, newRaw);
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

    // Acquire a dedicated client so the three writes are atomic — if any step
    // fails, ROLLBACK undoes all prior changes within this transaction.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
      await client.query(
        `UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
        [userId]
      );
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
    } catch (clientErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw clientErr;
    } finally {
      client.release();
    }

    audit.log(userId, 'password_change', req.ip, req.headers['user-agent']);
    audit.log(userId, 'password_reset_sessions_invalidated', req.ip, req.headers['user-agent']);
    res.json({ message: 'Password has been reset. You can now log in.' });
  } catch (err) {
    next(err);
  }
}

async function validateResetToken(req, res, next) {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const found = await db.query(
      `SELECT expires_at FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );

    if (found.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired reset token' });
    }

    res.json({ expires_at: found.rows[0].expires_at });
  } catch (err) {
    next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const { full_name, phone, preferred_language } = req.body;
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

    // Validate preferred_language if provided
    const ALLOWED_LOCALES = ['en', 'sw', 'fr', 'ha', 'yo'];
    const sanitizedLocale =
      preferred_language && ALLOWED_LOCALES.includes(preferred_language)
        ? preferred_language
        : null;

    await db.query(
      `UPDATE users SET
        full_name = COALESCE($1, full_name),
        phone = COALESCE($2, phone),
        phone_verified = COALESCE($3, phone_verified),
        phone_otp_hash = COALESCE($4, phone_otp_hash),
        phone_otp_expires_at = COALESCE($5, phone_otp_expires_at),
        preferred_language = COALESCE($6, preferred_language)
      WHERE id = $7`,
      [full_name || null, phone || null, phoneVerified, otpHashed, otpExpiresAt, sanitizedLocale, userId]
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

async function changeEmail(req, res, next) {
  try {
    const { new_email, password } = req.body;
    const userId = req.user.userId;

    const result = await db.query('SELECT password_hash, email FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Invalid password' });

    const existing = await db.query('SELECT id FROM users WHERE email = $1 AND id != $2', [new_email, userId]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already in use' });

    const { raw, hashed } = generateVerificationToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await db.query(
      `UPDATE users SET pending_email = $1, pending_email_token = $2, pending_email_token_expires_at = $3 WHERE id = $4`,
      [new_email, hashed, expiresAt, userId]
    );

    await sendVerificationEmail(new_email, raw);
    await sendEmailChangeRequestedNotice(user.email, new_email, req.ip, req.headers['user-agent']);

    audit.log(userId, 'email_change_requested', req.ip, req.headers['user-agent'], { new_email });
    res.json({ message: 'Verification email sent to new address. Check your inbox to confirm the change.' });
  } catch (err) {
    next(err);
  }
}

async function verifyEmailChange(req, res, next) {
  try {
    const token = req.body?.token || req.query.token;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const hashed = crypto.createHash('sha256').update(token).digest('hex');
    const result = await db.query(
      `SELECT id, pending_email, pending_email_token_expires_at FROM users WHERE pending_email_token = $1`,
      [hashed]
    );

    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
    if (new Date(user.pending_email_token_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token has expired' });
    }

    await db.query(
      `UPDATE users SET email = pending_email, pending_email = NULL, pending_email_token = NULL, pending_email_token_expires_at = NULL WHERE id = $1`,
      [user.id]
    );

    audit.log(user.id, 'email_changed', req.ip, req.headers['user-agent'], { new_email: user.pending_email });
    res.json({ message: 'Email address updated successfully.' });
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

async function completeOnboarding(req, res, next) {
  try {
    const userId = req.user.userId;
    await db.query('UPDATE users SET onboarding_completed = TRUE WHERE id = $1', [userId]);
    audit.log(userId, 'onboarding_completed', req.ip, req.headers['user-agent']);
    res.json({ message: 'Onboarding completed' });
  } catch (err) {
    next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    const { current_password, new_password } = req.body;
    const userId = req.user.userId;

    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!rows[0] || !(await bcrypt.compare(current_password, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);

    // Invalidate all other sessions
    const currentHash = req.headers.authorization
      ? require('crypto').createHash('sha256').update(req.headers.authorization.replace('Bearer ', '')).digest('hex')
      : null;
    if (currentHash) {
      await invalidateOtherSessions(userId, currentHash).catch(() => {});
    }

    audit.log(userId, 'password_change', req.ip, req.headers['user-agent']);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    next(err);
  }
}

// Magic-bytes signatures for allowed image types
const IMAGE_MAGIC = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png',  bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/webp', bytes: null, check: (b) => b[0]===0x52&&b[1]===0x49&&b[2]===0x46&&b[3]===0x46&&b[8]===0x57&&b[9]===0x45&&b[10]===0x42&&b[11]===0x50 },
];

function detectMime(buffer) {
  for (const sig of IMAGE_MAGIC) {
    if (sig.check) { if (buffer.length >= 12 && sig.check(buffer)) return sig.mime; }
    else if (buffer.slice(0, sig.bytes.length).every((b, i) => b === sig.bytes[i])) return sig.mime;
  }
  return null;
}

async function uploadAvatar(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const mime = detectMime(req.file.buffer);
    if (!mime) {
      return res.status(400).json({ error: 'Invalid file type. Only JPEG, PNG, and WebP are accepted.' });
    }

    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const filename = `${req.user.userId}_${Date.now()}.${ext}`;

    const path = require('path');
    const fs = require('fs');
    const dir = path.join(__dirname, '../../uploads/avatars');
    fs.mkdirSync(dir, { recursive: true });

    // Delete old avatar file if it exists
    const old = await db.query('SELECT avatar_url FROM users WHERE id = $1', [req.user.userId]);
    const oldUrl = old.rows[0]?.avatar_url;
    if (oldUrl) {
      const oldFile = path.join(dir, path.basename(oldUrl));
      fs.unlink(oldFile, () => {});
    }

    fs.writeFileSync(path.join(dir, filename), req.file.buffer);

    const avatarUrl = `/uploads/avatars/${filename}`;
    await db.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, req.user.userId]);

    res.json({ avatar_url: avatarUrl });
  } catch (err) {
    next(err);
  }
}

/**
 * Clear the httpOnly device-trust cookie (issue #995). Replaces the old
 * client-side `localStorage.removeItem('afripay_device_token')` flow.
 */
async function revokeDeviceTrust(req, res, next) {
  try {
    res.clearCookie(DEVICE_COOKIE_NAME, { ...DEVICE_COOKIE_OPTIONS, maxAge: undefined });
    res.json({ message: 'Device trust revoked' });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// WebAuthn / biometric credentials (#953)
//
// The frontend's PIN setup flow calls navigator.credentials.create() and, until
// now, only stored the resulting credential ID in localStorage — nothing on the
// server verified the attestation or kept the public key, so "biometric login"
// could not actually be cryptographically verified. These four endpoints make
// the server the source of truth: register/verify an attestation at setup time,
// then issue/verify an assertion challenge to log in.
// ---------------------------------------------------------------------------

async function webauthnRegisterOptions(req, res, next) {
  try {
    const userId = req.user.userId;
    const userResult = await db.query('SELECT email, full_name FROM users WHERE id = $1', [userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const { email, full_name } = userResult.rows[0];

    const existing = await db.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = $1', [userId]);
    const { rpName, rpID } = getRpConfig();

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(userId),
      userName: email,
      userDisplayName: full_name || email,
      attestationType: 'none',
      excludeCredentials: existing.rows.map((r) => ({ id: r.credential_id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });

    await cache.set(`webauthn:reg:${userId}`, options.challenge, WEBAUTHN_CHALLENGE_TTL_SECONDS);
    res.json(options);
  } catch (err) {
    next(err);
  }
}

async function webauthnRegister(req, res, next) {
  try {
    const userId = req.user.userId;
    const expectedChallenge = await cache.get(`webauthn:reg:${userId}`);
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'Registration challenge expired or not found. Please try again.' });
    }
    const { rpID, origin } = getRpConfig();

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (err) {
      logger.warn('WebAuthn registration verification failed', { userId, error: err.message });
      return res.status(400).json({ error: 'WebAuthn registration could not be verified' });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'WebAuthn registration could not be verified' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    await db.query(
      `INSERT INTO webauthn_credentials
         (id, user_id, credential_id, public_key, counter, device_type, backed_up, transports)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        uuidv4(),
        userId,
        credential.id,
        Buffer.from(credential.publicKey).toString('base64'),
        credential.counter,
        credentialDeviceType,
        credentialBackedUp,
        JSON.stringify(credential.transports || req.body?.response?.transports || []),
      ]
    );
    await cache.del(`webauthn:reg:${userId}`);

    audit.log(userId, 'webauthn_credential_registered', req.ip, req.headers['user-agent'], {
      credential_id: credential.id,
    });

    res.status(201).json({ message: 'Biometric credential registered' });
  } catch (err) {
    next(err);
  }
}

async function webauthnLoginOptions(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    const { rpID } = getRpConfig();

    // Don't reveal whether the account exists or has credentials registered —
    // an empty allowCredentials list still yields a valid (but unusable) challenge.
    let allowCredentials = [];
    if (userResult.rows[0]) {
      const creds = await db.query(
        'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1',
        [userResult.rows[0].id]
      );
      allowCredentials = creds.rows.map((r) => ({
        id: r.credential_id,
        transports: r.transports || undefined,
      }));
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials,
    });

    await cache.set(`webauthn:auth:${email}`, options.challenge, WEBAUTHN_CHALLENGE_TTL_SECONDS);
    res.json(options);
  } catch (err) {
    next(err);
  }
}

async function webauthnVerify(req, res, next) {
  try {
    const { email, response } = req.body;
    if (!email || !response) return res.status(400).json({ error: 'email and response are required' });

    const expectedChallenge = await cache.get(`webauthn:auth:${email}`);
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'Authentication challenge expired or not found. Please try again.' });
    }

    const userResult = await db.query(
      `SELECT u.id, u.full_name, u.email, u.role, w.public_key
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.email = $1`,
      [email]
    );
    const user = userResult.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'WebAuthn verification failed' });
    }

    const credRow = await db.query(
      'SELECT id, credential_id, public_key, counter FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2',
      [user.id, response.id]
    );
    if (!credRow.rows[0]) {
      audit.log(user.id, 'webauthn_login_failure', req.ip, req.headers['user-agent'], { reason: 'unknown_credential' });
      return res.status(401).json({ error: 'WebAuthn verification failed' });
    }
    const credential = credRow.rows[0];
    const storedCounter = Number(credential.counter);

    const { rpID, origin } = getRpConfig();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: credential.credential_id,
          publicKey: Uint8Array.from(Buffer.from(credential.public_key, 'base64')),
          counter: storedCounter,
        },
      });
    } catch (err) {
      audit.log(user.id, 'webauthn_login_failure', req.ip, req.headers['user-agent'], { reason: err.message });
      return res.status(401).json({ error: 'WebAuthn verification failed' });
    }

    // Reject a replayed/cloned authenticator — the signature counter must strictly
    // increase (authenticators reporting 0 for both sides don't support counters).
    const newCounter = verification.authenticationInfo?.newCounter ?? 0;
    if (!verification.verified || (newCounter !== 0 && newCounter <= storedCounter)) {
      audit.log(user.id, 'webauthn_login_failure', req.ip, req.headers['user-agent'], {
        reason: 'counter_replay',
        credential_id: credential.credential_id,
      });
      return res.status(401).json({ error: 'WebAuthn verification failed' });
    }

    await db.query('UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2', [
      newCounter,
      credential.id,
    ]);
    await cache.del(`webauthn:auth:${email}`);

    const token = signAccessToken({ userId: user.id, email: user.email, role: user.role });
    const { raw, hash } = generateRefreshToken();
    const expiresAt = refreshTokenExpiresAt();
    const familyId = uuidv4();
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, family_id, revoked)
       VALUES ($1, $2, $3, $4, $5, FALSE)`,
      [uuidv4(), user.id, hash, expiresAt, familyId]
    );
    await recordSession(user.id, token, req).catch(() => {});
    res.cookie(COOKIE_NAME, raw, COOKIE_OPTIONS);
    setCsrfCookie(res);
    audit.log(user.id, 'webauthn_login_success', req.ip, req.headers['user-agent']);

    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        wallet_address: user.public_key,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  revokeDeviceTrust,
  verifyEmail,
  resendVerification,
  verifyPhone,
  getMe,
  updateProfile,
  changeEmail,
  verifyEmailChange,
  getActivity,
  uploadAvatar,
  setPIN,
  verifyPIN,
  registerBiometric,
  getBiometricStatus,
  disableBiometric,
  setup2FA,
  verify2FA,
  disable2FA,
  forgotPassword,
  resetPassword,
  regenerateBackupCodes,
  getBackupCodeCount,
  changePassword,
  validateResetToken,
  webauthnRegisterOptions,
  webauthnRegister,
  webauthnLoginOptions,
  webauthnVerify,
  completeOnboarding,
};
