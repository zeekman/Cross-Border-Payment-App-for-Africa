const express = require('express');
const { param, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const { readLimiter } = require('../middleware/rateLimiter');
const { create, getById, markClaimed, listMine, cancel } = require('../controllers/paymentRequestController');

const router = express.Router();

router.post('/', auth, create);
// BE-224: reject non-UUID ids with 400 instead of letting Postgres raise (500).
const validateId = [
  param('id').isUUID().withMessage('id must be a valid UUID'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    next();
  },
];

router.get('/', auth, listMine);
router.get('/:id', readLimiter, validateId, getById);
router.delete('/:id', auth, validateId, cancel);
router.post('/:id/claim', auth, validateId, markClaimed);

module.exports = router;
