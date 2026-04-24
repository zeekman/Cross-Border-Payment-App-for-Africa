const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const {
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
} = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const geoRestriction = require('../middleware/geoRestriction');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.post(
  '/register',
  geoRestriction,
  [
    body('full_name').trim().notEmpty().withMessage('Full name is required'),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
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
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  validate,
  resetPassword
);

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
  [
    body('totp_code').matches(/^\d{6}$/).withMessage('TOTP code must be 6 digits')
  ],
  validate,
  verify2FA
);

router.post('/2fa/disable',
  authMiddleware,
  [
    body('password').notEmpty().withMessage('Password is required')
  ],
  validate,
  disable2FA
);

module.exports = router;
