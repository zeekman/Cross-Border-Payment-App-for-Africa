const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const db = require('../db');
const { detectTestnetReset, refundTestnetWallets } = require('../services/stellar');
const logger = require('../utils/logger');

// Block entirely outside development
router.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

router.post('/fund-wallet', authMiddleware, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key } = result.rows[0];
    const response = await fetch(`https://friendbot.stellar.org?addr=${public_key}`);
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Friendbot failed', detail: text });
    }

    res.json({ message: 'Wallet funded with 10,000 test XLM', public_key });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/dev/handle-testnet-reset
 * Re-funds all testnet wallets via Friendbot and clears stale transaction records.
 * Only available in development mode.
 */
router.post('/handle-testnet-reset', async (req, res, next) => {
  try {
    const resetDetected = await detectTestnetReset();
    if (!resetDetected) {
      return res.json({ reset: false, message: 'No testnet reset detected. Canary account is alive.' });
    }

    logger.warn('Testnet reset confirmed — re-funding wallets and clearing stale records');

    // Fetch all wallet public keys
    const { rows: wallets } = await db.query('SELECT public_key FROM wallets');
    const publicKeys = wallets.map((w) => w.public_key);

    // Re-fund via Friendbot
    const fundResults = await refundTestnetWallets(publicKeys);

    // Clear stale transaction records
    await db.query("DELETE FROM transactions WHERE status != 'failed'");

    logger.info('Testnet reset recovery complete', { walletsRefunded: publicKeys.length });

    res.json({
      reset: true,
      message: 'Testnet reset handled: wallets re-funded and stale transactions cleared.',
      wallets: fundResults,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
