const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const { getChallenge, postChallenge } = require('../controllers/sep10Controller');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.get('/auth',
  [
    query('account').isLength({ min: 56, max: 56 }).withMessage('Invalid Stellar account')
  ],
  validate,
  getChallenge
);

router.post('/auth',
  [
    body('transaction').notEmpty().withMessage('transaction required')
  ],
  validate,
  postChallenge
);

module.exports = router;
