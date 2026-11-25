const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');
const { summary, fees, volume, refresh } = require('../controllers/analyticsController');

// All analytics routes require authentication and admin role
router.use(authMiddleware, isAdmin);

router.get('/summary', summary);
router.get('/fees', fees);
router.get('/volume', volume);
router.post('/refresh', refresh);

module.exports = router;
