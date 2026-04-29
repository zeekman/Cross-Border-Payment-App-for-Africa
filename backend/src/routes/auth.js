const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const {
  register,
  login,
  refresh,
  logout,
  verifyEmail,
  getMe,
  setPIN,
  verifyPIN,
  verifyPhone,
  getMe,
  updateProfile,
  changeEmail,
  verifyEmailChange,
  getActivity,
  setPIN,
  verifyPIN,
  setup2FA,
  verify2FA,
  disable2FA,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const geoRestriction = require('../middleware/geoRestriction');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const PASSWORD_MIN_LENGTH = parseInt(process.env.PASSWORD_MIN_LENGTH, 10) || 8;

/**
 * Validates password strength and returns a list of unmet requirements.
 * Rules: min length, uppercase, lowercase, digit, special character.
 */
function checkPasswordStrength(password) {
  const unmet = [];
  if (password.length < PASSWORD_MIN_LENGTH)
    unmet.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  if (!/[A-Z]/.test(password))
    unmet.push('at least one uppercase letter');
  if (!/[a-z]/.test(password))
    unmet.push('at least one lowercase letter');
  if (!/\d/.test(password))
    unmet.push('at least one digit');
  if (!/[^A-Za-z0-9]/.test(password))
    unmet.push('at least one special character');
  return unmet;
}

router.post(
  '/register',
  geoRestriction,
  [
    body('full_name').trim().notEmpty().withMessage('Full name is required'),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('password')
      .notEmpty().withMessage('Password is required')
      .custom((value) => {
        const unmet = checkPasswordStrength(value);
        if (unmet.length > 0) {
          throw new Error(`Password does not meet requirements: ${unmet.join(', ')}`);
        }
        return true;
      }),
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
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
    body('token').trim().notEmpty().withMessage('Reset token is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  validate,
  resetPassword
);

router.post('/refresh', refresh);
router.post('/logout', logout);

router.get('/verify-email', verifyEmail);
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
router.get('/verify-email-change', verifyEmailChange);
router.get('/activity', authMiddleware, getActivity);
router.post('/refresh', refresh);
router.post('/logout', logout);

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

router.post('/2fa/setup', authMiddleware, setup2FA);

router.post('/2fa/verify',
  authMiddleware,
  [body('pin').matches(/^\d{4,6}$/).withMessage('PIN must be 4-6 digits')],
  [
    body('totp_code').matches(/^\d{6}$/).withMessage('TOTP code must be 6 digits')
  ],
  validate,
  verify2FA
);

router.post('/2fa/disable',
  authMiddleware,
  [body('pin').matches(/^\d{4,6}$/).withMessage('PIN must be 4-6 digits')],
  [
    body('password').notEmpty().withMessage('Password is required')
  ],
  validate,
  disable2FA
);

const { listSessions, revokeSession, revokeAllSessions } = require('../controllers/sessionController');

module.exports = router;

// Session management routes (all require auth)
router.get('/sessions', authMiddleware, listSessions);
router.delete('/sessions', authMiddleware, revokeAllSessions);
router.delete('/sessions/:id', authMiddleware, revokeSession);
