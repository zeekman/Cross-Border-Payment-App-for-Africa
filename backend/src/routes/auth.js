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
} = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const geoRestriction = require('../middleware/geoRestriction');
const { verifyCsrf } = require('../middleware/csrf');
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
router.get('/password-policy', (req, res) => res.json(getPolicy()));

router.post(
  '/register',
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
  geoRestriction,
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  validate,
  login
);

router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail()],
  validate,
  forgotPassword
);

router.post(
  '/reset-password',
  [
    body('token').trim().notEmpty().withMessage('Reset token is required'),
    body('password')
      .notEmpty().withMessage('Password is required')
      .custom(passwordStrengthCheck('Password does not meet requirements')),
  ],
  validate,
  resetPassword
);

router.get('/reset-password/validate', validateResetToken);

router.post('/refresh', verifyCsrf, refresh);
router.post('/logout', verifyCsrf, logout);

// Token-bearing endpoints: POST is preferred; GET variants are deprecated.
const noReferrer = (_req, res, next) => { res.set('Referrer-Policy', 'no-referrer'); next(); };
const deprecatedGet = (_req, res, next) => { res.set('Deprecation', 'true'); next(); };
router.post('/verify-email', noReferrer, [body('token').trim().notEmpty()], validate, verifyEmail);
router.get('/verify-email', noReferrer, deprecatedGet, verifyEmail);
router.post(
  '/resend-verification',
  [body('email').isEmail().normalizeEmail()],
  validate,
  resendVerification
);
router.post(
  '/verify-phone',
  authMiddleware,
  [body('otp').matches(/^\d{6}$/).withMessage('OTP must be 6 digits')],
  validate,
  verifyPhone
);
router.get('/me', authMiddleware, getMe);
router.patch('/me', authMiddleware, updateProfile);
router.post(
  '/change-email',
  authMiddleware,
  [
    body('new_email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  changeEmail
);
router.post('/verify-email-change', noReferrer, [body('token').trim().notEmpty()], validate, verifyEmailChange);
router.get('/verify-email-change', noReferrer, deprecatedGet, verifyEmailChange);
router.get('/activity', authMiddleware, getActivity);
router.post('/onboarding-completed', authMiddleware, completeOnboarding);

router.post(
  '/set-pin',
  authMiddleware,
  [body('pin').matches(/^\d{4,6}$/).withMessage('PIN must be 4-6 digits')],
  validate,
  setPIN
);

router.post(
  '/verify-pin',
  authMiddleware,
  [body('pin').matches(/^\d{4,6}$/).withMessage('PIN must be 4-6 digits')],
  validate,
  verifyPIN
);

router.post(
  '/biometric/register',
  authMiddleware,
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
  [body('credential_id').optional().isString()],
  validate,
  disableBiometric
);

router.post('/2fa/setup', authMiddleware, setup2FA);

router.post(
  '/2fa/verify',
  authMiddleware,
  [body('totp_code').matches(/^\d{6}$/).withMessage('TOTP code must be 6 digits')],
  validate,
  verify2FA
);

router.post(
  '/2fa/disable',
  authMiddleware,
  [body('password').notEmpty().withMessage('Password is required')],
  validate,
  disable2FA
);

router.post(
  '/2fa/backup-codes/regenerate',
  authMiddleware,
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
  avatarUpload.single('avatar'),
  uploadAvatar
);

// WebAuthn / biometric credentials
router.post('/webauthn/register/options', authMiddleware, webauthnRegisterOptions);
router.post('/webauthn/register', authMiddleware, webauthnRegister);
router.post(
  '/webauthn/verify/options',
  [body('email').isEmail().normalizeEmail()],
  validate,
  webauthnLoginOptions
);
router.post('/webauthn/verify', webauthnVerify);

// Session management
router.get('/sessions', authMiddleware, listSessions);
router.delete('/sessions', authMiddleware, revokeAllSessions);
router.delete('/sessions/:id', authMiddleware, revokeSession);

// Device trust (issue #995) — clears the httpOnly device-trust cookie.
router.delete('/device-trust', authMiddleware, revokeDeviceTrust);

module.exports = router;
