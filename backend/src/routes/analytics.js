const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');
const { summary } = require('../controllers/analyticsController');

// All analytics routes require authentication and admin role
router.use(authMiddleware, isAdmin);

router.get('/summary', summary);

module.exports = router;
