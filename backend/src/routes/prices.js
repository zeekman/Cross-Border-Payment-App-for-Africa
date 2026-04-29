const router = require('express').Router();
const { getXlmRates } = require('../services/priceOracle');

/**
 * GET /api/prices/xlm
 * Returns current XLM price in USD, NGN, GHS, KES sourced from the Stellar SDEX.
 */
router.get('/xlm', async (req, res, next) => {
  try {
    const rates = await getXlmRates();
    res.json({ asset: 'XLM', rates, source: 'stellar-sdex', timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
