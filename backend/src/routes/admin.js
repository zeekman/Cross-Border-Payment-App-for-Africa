const router = require('express').Router();
const auth = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');
const { getStats, getUsers, getTransactions } = require('../controllers/adminController');

router.use(auth, isAdmin);

router.get('/stats',        getStats);
router.get('/users',        getUsers);
router.get('/transactions', getTransactions);

module.exports = router;
