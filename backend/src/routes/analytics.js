const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const { summary } = require('../controllers/analyticsController');

const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.userId || req.ip,
  message: { error: 'Too many analytics requests, please try again later.' },
});

router.use(authMiddleware);

router.get('/summary', analyticsLimiter, summary);

module.exports = router;
