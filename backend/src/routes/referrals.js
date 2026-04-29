const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const { getStats } = require('../controllers/referralController');

router.use(authMiddleware);

router.get('/stats', getStats);

module.exports = router;
