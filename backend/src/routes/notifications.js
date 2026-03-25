const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const { subscribe, unsubscribe } = require('../controllers/notificationController');

router.use(authMiddleware);

router.post('/subscribe', subscribe);
router.delete('/subscribe', unsubscribe);

module.exports = router;
