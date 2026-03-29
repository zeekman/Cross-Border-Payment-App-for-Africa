const router = require('express').Router();
const { query, body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const db = require('../db');
const { getOrderbook, executeSwap } = require('../services/dex');

const VALID_ASSETS = /^[A-Z0-9]{1,12}$/;

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /api/dex/orderbook?selling=XLM&buying=USDC
router.get('/orderbook',
  [
    query('selling').matches(VALID_ASSETS).withMessage('Invalid selling asset'),
    query('buying').matches(VALID_ASSETS).withMessage('Invalid buying asset'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const data = await getOrderbook(req.query.selling, req.query.buying);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/dex/swap
router.post('/swap',
  authMiddleware,
  [
    body('sell_asset').matches(VALID_ASSETS).withMessage('Invalid sell_asset'),
    body('sell_amount').isFloat({ gt: 0 }).withMessage('sell_amount must be > 0'),
    body('buy_asset').matches(VALID_ASSETS).withMessage('Invalid buy_asset'),
    body('slippage_pct').optional().isFloat({ min: 0, max: 50 }).withMessage('slippage_pct must be 0–50'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { sell_asset, sell_amount, buy_asset, slippage_pct } = req.body;

      const walletResult = await db.query(
        'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1',
        [req.user.userId]
      );
      if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

      const { public_key, encrypted_secret_key } = walletResult.rows[0];

      const result = await executeSwap({
        publicKey: public_key,
        encryptedSecretKey: encrypted_secret_key,
        sellAsset: sell_asset,
        sellAmount: sell_amount,
        buyAsset: buy_asset,
        slippagePct: slippage_pct,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
