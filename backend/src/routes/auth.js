const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const {
  register,
  login,
  refresh,
  logout,
  verifyEmail,
  resendVerification,
  verifyPhone,
  updateProfile,
  changeEmail,
  verifyEmailChange,
  getActivity,
  getMe,
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
  revokeDeviceTrust,
  webauthnRegisterOptions,
  webauthnRegister,
  webauthnLoginOptions,
  webauthnVerify,
  completeOnboarding,
  resendPhoneOTP,
  FORGOT_PASSWORD_MESSAGE,
} = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const phoneVerificationAuth = require('../middleware/phoneVerificationAuth');
const { phoneOtpLimiter } = require('../middleware/rateLimiter');
const geoRestriction = require('../middleware/geoRestriction');
const { verifyCsrf } = require('../middleware/csrf');
const {
  authLimiter,
  createEmailSendLimiter,
  emailSendLimiter,
  tokenVerifyLimiter,
  secondFactorLimiter,
  phoneOtpVerifyLimiter,
  smsSendLimiter,
  authActionLimiter,
} = require('../middleware/rateLimiter');
const { listSessions, revokeSession, revokeAllSessions } = require('../controllers/sessionController');

const { getPolicy, checkPasswordStrength } = require('../services/passwordPolicy');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// Express-validator custom check backed by the shared password policy
// (services/passwordPolicy.js) — used on every endpoint that sets a password
// so register, reset and change-password can never drift apart.
const passwordStrengthCheck = (message) => (value) => {
  const unmet = checkPasswordStrength(value);
  if (unmet.length === 0) return true;
  throw new Error(`${message}: ${unmet.join(', ')}`);
};

// Public config: the exact policy the backend enforces, served for the
// frontend to derive its validation from (single source of truth).
// Every route below mounts an explicit rate limiter (BE-194). forgot-password
// answers a throttled request with its usual generic 200 so the limiter can't
// be used to probe whether an email is registered.
const forgotPasswordLimiter = createEmailSendLimiter({ limitedResponse: FORGOT_PASSWORD_MESSAGE });

router.get('/password-policy', (req, res) => res.json(getPolicy()));

router.post(
  '/register',
  authLimiter,
  geoRestriction,
  [
    body('full_name').trim().notEmpty().withMessage('Full name is required'),
    body('email').isEmail().normalizeEmail(),
    body('password')
      .notEmpty().withMessage('Password is required')
      .custom(passwordStrengthCheck('Password does not meet requirements')),
  ],
  validate,
  register
);

router.post(
  '/login',
  authLimiter,
  geoRestriction,
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  validate,
  login
);

router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  [body('email').isEmail().normalizeEmail()],
  validate,
  forgotPassword
);

router.post(
  '/reset-password',
  tokenVerifyLimiter,
  [
    body('token').trim().notEmpty().withMessage('Reset token is required'),
    body('password')
      .notEmpty().withMessage('Password is required')
      .custom(passwordStrengthCheck('Password does not meet requirements')),
  ],
  validate,
  resetPassword
);

router.get('/reset-password/validate', tokenVerifyLimiter, validateResetToken);

router.post('/refresh', authActionLimiter, verifyCsrf, refresh);
router.post('/logout', authActionLimiter, verifyCsrf, logout);

// Token-bearing endpoints: POST is preferred; GET variants are deprecated.
const noReferrer = (_req, res, next) => { res.set('Referrer-Policy', 'no-referrer'); next(); };
const deprecatedGet = (_req, res, next) => { res.set('Deprecation', 'true'); next(); };
router.post('/verify-email', tokenVerifyLimiter, noReferrer, [body('token').trim().notEmpty()], validate, verifyEmail);
router.get('/verify-email', tokenVerifyLimiter, noReferrer, deprecatedGet, verifyEmail);
router.post(
  '/resend-verification',
  emailSendLimiter,
  [body('email').isEmail().normalizeEmail()],
  validate,
  resendVerification
);
// BE-197: accepts the phone_verification_token from /register (no session
// exists yet at that point) or a normal access token.
router.post(
  '/verify-phone',
  phoneVerificationAuth,
  phoneOtpLimiter,
  authMiddleware,
  secondFactorLimiter,
  phoneOtpVerifyLimiter,
  [body('otp').matches(/^\d{6}$/).withMessage('OTP must be 6 digits')],
  validate,
  verifyPhone
);
/**
 * @openapi
 * /api/auth/phone/resend-otp:
 *   post:
 *     summary: Resend the phone verification OTP
 *     description: >
 *       Issues a new 6-digit OTP to the user's unverified phone number. The
 *       previous code stops working and the failed-attempt counter resets.
 *       Limited to one send per 60 seconds, 5 per day per user and 10 per
 *       day per phone number across accounts.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OTP sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 resend_available_at: { type: string, format: date-time }
 *                 expires_at: { type: string, format: date-time }
 *       400:
 *         description: No phone on file (PHONE_NOT_SET) or already verified (PHONE_ALREADY_VERIFIED)
 *       429:
 *         description: Cooldown (OTP_RESEND_COOLDOWN) or daily cap (OTP_RESEND_LIMIT) hit; body includes resend_available_at
 *       502:
 *         description: SMS provider failed to deliver the code (SMS_DELIVERY_FAILED)
 */
router.post('/phone/resend-otp', authMiddleware, smsSendLimiter, resendPhoneOTP);
router.get('/me', authMiddleware, getMe);
router.patch('/me', authMiddleware, authActionLimiter, updateProfile);
router.post(
  '/change-email',
  authMiddleware,
  emailSendLimiter,
  [
    body('new_email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  changeEmail
);
router.post('/verify-email-change', tokenVerifyLimiter, noReferrer, [body('token').trim().notEmpty()], validate, verifyEmailChange);
router.get('/verify-email-change', tokenVerifyLimiter, noReferrer, deprecatedGet, verifyEmailChange);
router.get('/activity', authMiddleware, getActivity);
router.post('/onboarding-completed', authMiddleware, authActionLimiter, completeOnboarding);

router.post(
  '/set-pin',
  authMiddleware,
  authActionLimiter,
  [body('pin').matches(/^\d{4,6}$/).withMessage('PIN must be 4-6 digits')],
  validate,
  setPIN
);

router.post(
  '/verify-pin',
  authMiddleware,
  secondFactorLimiter,
  [body('pin').matches(/^\d{4,6}$/).withMessage('PIN must be 4-6 digits')],
  validate,
  verifyPIN
);

router.post(
  '/biometric/register',
  authMiddleware,
  authActionLimiter,
  [
    body('credential_id').notEmpty().withMessage('credential_id is required'),
    body('device_label').optional().isString().trim(),
  ],
  validate,
  registerBiometric
);

router.get('/biometric/status', authMiddleware, getBiometricStatus);

router.post(
  '/biometric/disable',
  authMiddleware,
  authActionLimiter,
  [body('credential_id').optional().isString()],
  validate,
  disableBiometric
);

router.post('/2fa/setup', authMiddleware, authActionLimiter, setup2FA);

router.post(
  '/2fa/verify',
  authMiddleware,
  secondFactorLimiter,
  [body('totp_code').matches(/^\d{6}$/).withMessage('TOTP code must be 6 digits')],
  validate,
  verify2FA
);

router.post(
  '/2fa/disable',
  authMiddleware,
  secondFactorLimiter,
  [body('password').notEmpty().withMessage('Password is required')],
  validate,
  disable2FA
);

router.post(
  '/2fa/backup-codes/regenerate',
  authMiddleware,
  secondFactorLimiter,
  [body('totp_code').matches(/^\d{6}$/).withMessage('TOTP code must be 6 digits')],
  validate,
  regenerateBackupCodes
);

router.get('/2fa/backup-codes/count', authMiddleware, getBackupCodeCount);

// Avatar upload — 5 MB limit, memory storage (magic bytes checked in controller)
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, and WebP files are allowed'));
  },
});

// Change password — invalidates all other active sessions
router.patch(
  '/password',
  authMiddleware,
  secondFactorLimiter,
  [
    body('current_password').notEmpty().withMessage('Current password is required'),
    body('new_password')
      .notEmpty().withMessage('New password is required')
      .custom(passwordStrengthCheck('New password does not meet requirements')),
  ],
  validate,
  changePassword
);

router.post(
  '/avatar',
  authMiddleware,
  authActionLimiter,
  avatarUpload.single('avatar'),
  uploadAvatar
);

// WebAuthn / biometric credentials
router.post('/webauthn/register/options', authMiddleware, authActionLimiter, webauthnRegisterOptions);
router.post('/webauthn/register', authMiddleware, authActionLimiter, webauthnRegister);
router.post(
  '/webauthn/verify/options',
  authActionLimiter,
  [body('email').isEmail().normalizeEmail()],
  validate,
  webauthnLoginOptions
);
router.post('/webauthn/verify', secondFactorLimiter, webauthnVerify);

// Session management
router.get('/sessions', authMiddleware, listSessions);
router.delete('/sessions', authMiddleware, revokeAllSessions);
router.delete('/sessions/:id', authMiddleware, revokeSession);

// Device trust (issue #995) — clears the httpOnly device-trust cookie.
router.delete('/device-trust', authMiddleware, revokeDeviceTrust);

module.exports = router;
