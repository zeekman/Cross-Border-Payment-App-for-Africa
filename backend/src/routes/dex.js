const router = require('express').Router();
const { query, body, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const db = require('../db');
const idempotency = require('../middleware/idempotency');
const { getOrderbook, executeSwap, getTradeHistory } = require('../services/dex');
const cache = require('../utils/cache');
const { parseAssetParam, getOrderbook, executeSwap, getTradeHistory } = require('../services/dex');

const ORDERBOOK_TTL = 5; // seconds — one Stellar ledger close

// Accepts "XLM" or "CODE" or "CODE:GISSUER..."
const ASSET_PARAM_RE = /^[A-Z0-9]{1,12}(:[A-Z2-7]{56})?$/i;

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

/**
 * GET /api/dex/orderbook
 * @public — read-only market data, no wallet access required.
 */
router.get('/orderbook',
  [
    query('selling')
      .matches(ASSET_PARAM_RE)
      .withMessage('selling must be XLM, a CODE, or CODE:GISSUER'),
    query('buying')
      .matches(ASSET_PARAM_RE)
      .withMessage('buying must be XLM, a CODE, or CODE:GISSUER'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 200 })
      .withMessage('limit must be 1–200'),
    query('amount')
      .optional()
      .isFloat({ gt: 0 })
      .withMessage('amount must be a positive number'),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Validate asset params early to return a clean 400 before hitting Horizon
      try {
        parseAssetParam(req.query.selling);
        parseAssetParam(req.query.buying);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const limit  = req.query.limit  ? parseInt(req.query.limit, 10) : 10;
      const amount = req.query.amount ? parseFloat(req.query.amount)  : null;
      const cacheKey = `orderbook:${req.query.selling}:${req.query.buying}:${limit}:${amount ?? ''}`;

      const cached = await cache.get(cacheKey);
      if (cached) return res.json(cached);

      const data = await getOrderbook(req.query.selling, req.query.buying, limit, amount);
      await cache.set(cacheKey, data, ORDERBOOK_TTL);
      res.json(data);
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      next(err);
    }
  }
);

/**
 * POST /api/dex/swap
 * @protected — accesses and signs with the authenticated user's wallet.
 * Body: sell_asset, sell_amount, buy_asset, plus either
 *   - min_received (decimal string): binding destMin for the path payment, or
 *   - slippage_pct (0–50, default 1): used to derive destMin from the server quote.
 * Supports the Idempotency-Key header.
 */
router.post('/swap',
  authMiddleware,
  [
    body('sell_asset').matches(ASSET_PARAM_RE).withMessage('Invalid sell_asset'),
    body('sell_amount').isFloat({ gt: 0 }).withMessage('sell_amount must be > 0'),
    body('buy_asset').matches(ASSET_PARAM_RE).withMessage('Invalid buy_asset'),
    body('slippage_pct').optional().isFloat({ min: 0, max: 50 }).withMessage('slippage_pct must be 0–50'),
    body('min_received').optional().matches(/^\d+(\.\d{1,7})?$/).withMessage('min_received must be a decimal string with up to 7 decimals')
      .bail().custom((v) => parseFloat(v) > 0).withMessage('min_received must be > 0'),
  ],
  validate,
  idempotency,
  async (req, res, next) => {
    try {
      const { sell_asset, sell_amount, buy_asset, slippage_pct, min_received } = req.body;

      const walletResult = await db.query(
        'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
        [req.user.userId]
      );
      if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

      const { public_key, encrypted_secret_key } = walletResult.rows[0];

      // Issue #1156: Apply compliance checks to DEX swaps (value-moving endpoint)
      const { ensureKycIfNeeded, amlRescreenForPayment, dailyLimitExceeded, checkFraud, logFraudBlock } = require('../controllers/paymentController');
      const { estimateUSDValue } = require('../controllers/paymentController');
      
      // Use sell_asset for compliance thresholds
      await ensureKycIfNeeded(req.user.userId, sell_amount, sell_asset);
      
      const estimatedUSD = estimateUSDValue(sell_amount, sell_asset);
      await amlRescreenForPayment(req.user.userId, public_key, estimatedUSD);
      
      const overLimit = await dailyLimitExceeded(public_key, sell_amount);
      if (overLimit) {
        return res.status(400).json({
          error: 'Daily send limit reached. Try again tomorrow.',
          code: 'DAILY_LIMIT_EXCEEDED',
        });
      }
      
      const fraudCheck = await checkFraud(public_key, sell_amount, sell_asset);
      if (fraudCheck.blocked) {
        await logFraudBlock(public_key, fraudCheck.reason, sell_amount, sell_asset);
        return res.status(429).json({ error: fraudCheck.reason });
      }

      const result = await executeSwap({
        publicKey: public_key,
        encryptedSecretKey: encrypted_secret_key,
        sellAsset: sell_asset,
        sellAmount: sell_amount,
        buyAsset: buy_asset,
        slippagePct: slippage_pct,
        minReceived: min_received,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/dex/trades
 * @protected — returns Horizon trade history for the authenticated user's wallet.
 * Calls getTradeHistory from services/dex.js.
 */
router.get('/trades',
  authMiddleware,
  [
    query('cursor').optional().isString().trim().notEmpty().withMessage('cursor must be a non-empty string'),
    query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('limit must be 1–200'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
      const cursor = req.query.cursor || null;

      const walletResult = await db.query(
        'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC LIMIT 1',
        [req.user.userId]
      );
      if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

      const trades = await getTradeHistory(walletResult.rows[0].public_key, cursor, limit);
      res.json({ trades });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/dex/offers/history
 * @protected — returns offer history scoped to the authenticated user's wallet.
 */
router.get(
  '/offers/history',
  authMiddleware,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1–100'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 20);
      const offset = (page - 1) * limit;

      const walletResult = await db.query(
        'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC LIMIT 1',
        [req.user.userId]
      );
      if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

      const { public_key } = walletResult.rows[0];

      const [countResult, rowsResult] = await Promise.all([
        db.query(
          'SELECT COUNT(*) FROM offer_events WHERE wallet_address = $1',
          [public_key]
        ),
        db.query(
          `SELECT id, offer_id, event_type, base_asset, counter_asset,
                  base_amount, counter_amount, price, ledger_close_time, created_at
           FROM offer_events
           WHERE wallet_address = $1
           ORDER BY ledger_close_time DESC NULLS LAST
           LIMIT $2 OFFSET $3`,
          [public_key, limit, offset]
        ),
      ]);

      res.json({
        events: rowsResult.rows,
        total: parseInt(countResult.rows[0].count, 10),
        page,
        limit,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
