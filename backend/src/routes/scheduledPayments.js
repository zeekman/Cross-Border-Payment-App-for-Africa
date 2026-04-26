const express = require('express');
const auth = require('../middleware/auth');
const { create, list, update, delete: delete_ } = require('../controllers/scheduledPaymentController');

const router = express.Router();

router.post('/', auth, create);
router.get('/', auth, list);
router.put('/:id', auth, update);
router.delete('/:id', auth, delete_);

module.exports = router;
