const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { register, login, verifyEmail, getMe } = require('../controllers/authController');
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

router.get('/verify-email', verifyEmail);
router.get('/me', authMiddleware, getMe);

module.exports = router;
