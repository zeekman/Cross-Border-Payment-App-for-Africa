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
  (req, res, next) => secondFactorLimiter(req, res, next),
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

const multer = require('multer');
const rateLimit = require('express-rate-limit');
const {
  getPinPolicy,
  webauthnRegisterOptions,
  webauthnRegister,
  webauthnStepUpOptions,
  webauthnStepUpVerify,
  uploadAvatar,
} = require('../controllers/securityController');

// Second-factor limiter: protects PIN / WebAuthn step-up endpoints from brute force.
const secondFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.SECOND_FACTOR_RATE_LIMIT, 10) || 10,
  keyGenerator: (req) => req.user?.userId || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});

/**
 * @openapi
 * /api/auth/pin-policy:
 *   get:
 *     summary: PIN rules (min length and weak-PIN rules) for client-side validation
 *     tags: [Auth]
 *     responses:
 *       200: { description: Policy with min_length, max_length and rules[] }
 */
router.get('/pin-policy', getPinPolicy);

router.post('/webauthn/register/options', authMiddleware, webauthnRegisterOptions);
router.post('/webauthn/register', authMiddleware, webauthnRegister);

/**
 * @openapi
 * /api/auth/webauthn/step-up/options:
 *   post:
 *     summary: Start biometric step-up — returns WebAuthn assertion options (challenge valid 2 min, single use)
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               transaction: { type: object, properties: { amount: { type: string }, recipient: { type: string } } }
 *     responses:
 *       200: { description: PublicKeyCredentialRequestOptions (userVerification required) }
 *       404: { description: No credential registered }
 * /api/auth/webauthn/step-up/verify:
 *   post:
 *     summary: Verify a WebAuthn assertion (UV flag required) and receive a step-up token
 *     description: Send the returned token as X-Step-Up-Token on money-moving routes.
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assertion]
 *             properties:
 *               assertion: { type: object, description: AuthenticationResponseJSON }
 *               transaction: { type: object, description: Must match the transaction bound in options }
 *     responses:
 *       200: { description: "{ step_up_token }" }
 *       401: { description: Invalid, replayed or non-UV assertion }
 */
router.post('/webauthn/step-up/options', authMiddleware, secondFactorLimiter, webauthnStepUpOptions);
router.post('/webauthn/step-up/verify', authMiddleware, secondFactorLimiter, webauthnStepUpVerify);

router.post('/avatar', authMiddleware, avatarUpload.single('avatar'), uploadAvatar);

module.exports = router;

// Session management routes (all require auth)
router.get('/sessions', authMiddleware, listSessions);
router.delete('/sessions', authMiddleware, revokeAllSessions);
router.delete('/sessions/:id', authMiddleware, revokeSession);
