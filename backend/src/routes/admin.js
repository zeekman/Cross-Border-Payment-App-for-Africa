const router = require('express').Router();
const auth = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');
const { getStats, getUsers, getTransactions, getStellarNetworkStats } = require('../controllers/adminController');
const { issueTokens } = require('../controllers/assetController');

router.use(auth, isAdmin);

router.get('/stats',        getStats);
router.get('/users',        getUsers);
router.get('/transactions', getTransactions);
router.get('/stellar-stats', getStellarNetworkStats);
router.post('/assets/issue', issueTokens);

module.exports = router;
