const express = require('express');
const auth = require('../middleware/auth');
const { deposit, withdraw, status } = require('../controllers/anchorController');

const router = express.Router();

router.post('/deposit', auth, deposit);
router.post('/withdraw', auth, withdraw);
router.get('/transaction/:id', status);

module.exports = router;
