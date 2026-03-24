const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const { create, list } = require('../controllers/webhookController');

router.use(authMiddleware);

router.post('/', create);
router.get('/', list);

module.exports = router;
