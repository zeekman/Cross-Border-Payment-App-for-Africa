const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const {
  register,
  login,
  verifyEmail,
  getMe,
  setPIN,
  verifyPIN
  verifyPIN,
  forgotPassword,
  resetPassword
} = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.post('/register',
  [
    body('full_name').trim().notEmpty().withMessage('Full name is required'),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  ],
  validate,
  register
);

router.post('/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
  ],
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
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  ],
  validate,
  resetPassword
);

router.get('/verify-email', verifyEmail);
router.get('/me', authMiddleware, getMe);

router.post('/set-pin',
  authMiddleware,
  [
    body('pin').matches(/^\d{4,6}$/).withMessage('PIN must be 4-6 digits')
  ],
  validate,
  setPIN
);

router.post('/verify-pin',
  authMiddleware,
  [
    body('pin').matches(/^\d{4,6}$/).withMessage('PIN must be 4-6 digits')
  ],
  validate,
  verifyPIN
);

module.exports = router;
