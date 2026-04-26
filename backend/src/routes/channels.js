const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const { openChannel, transact, closeChannel } = require('../services/paymentChannel');
const db = require('../db');

router.use(authMiddleware);

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// POST /api/channels/open
router.post('/open',
  body('recipientPublicKey').isString().notEmpty(),
  body('fundingAmount').isFloat({ gt: 0 }),
  body('asset').optional().isIn(['XLM', 'USDC']),
  validate,
  async (req, res, next) => {
    try {
      const { rows: [wallet] } = await db.query(
        'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1',
        [req.user.id]
      );
      if (!wallet) return res.status(400).json({ error: 'Wallet not found' });

      const channel = await openChannel({
        userId: req.user.id,
        senderPublicKey: wallet.public_key,
        encryptedSecretKey: wallet.encrypted_secret_key,
        recipientPublicKey: req.body.recipientPublicKey,
        fundingAmount: req.body.fundingAmount,
        asset: req.body.asset || 'XLM',
      });
      res.status(201).json(channel);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/channels/transact
router.post('/transact',
  body('channelId').isUUID(),
  body('amount').isFloat({ gt: 0 }),
  validate,
  async (req, res, next) => {
    try {
      const channel = await transact({
        channelId: req.body.channelId,
        userId: req.user.id,
        amount: req.body.amount,
      });
      res.json(channel);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/channels/close
router.post('/close',
  body('channelId').isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { rows: [wallet] } = await db.query(
        'SELECT encrypted_secret_key FROM wallets WHERE user_id = $1',
        [req.user.id]
      );
      if (!wallet) return res.status(400).json({ error: 'Wallet not found' });

      const channel = await closeChannel({
        channelId: req.body.channelId,
        userId: req.user.id,
        encryptedSecretKey: wallet.encrypted_secret_key,
      });
      res.json(channel);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/channels — list user's channels
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, recipient_public_key, asset, funding_amount,
              sender_balance, recipient_balance, status, created_at
       FROM payment_channels WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
