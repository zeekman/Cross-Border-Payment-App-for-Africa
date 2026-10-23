const express = require('express');
const auth = require('../middleware/auth');
const { create, getById, markClaimed, listMine, cancel } = require('../controllers/paymentRequestController');

const router = express.Router();

router.post('/', auth, create);
router.get('/', auth, listMine);
router.get('/:id', getById);
router.delete('/:id', auth, cancel);
router.post('/:id/claim', auth, markClaimed);

module.exports = router;
