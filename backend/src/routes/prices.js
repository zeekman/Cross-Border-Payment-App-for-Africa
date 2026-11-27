const router = require('express').Router();
const { getXlmRates, getCurrencies } = require('../services/priceOracle');

/**
 * GET /api/prices/xlm
 * XLM price in USD and every configured fiat currency (SUPPORTED_FIAT).
 * 503 when the price is older than PRICE_MAX_STALENESS_SECS.
 */
router.get('/xlm', async (req, res, next) => {
  try {
    const { rates, currencies, unavailable, partial, fetchedAt } = await getXlmRates();
    res.json({ asset: 'XLM', rates, currencies, partial, unavailable, source: 'stellar-sdex', fetchedAt, timestamp: new Date().toISOString() });
  } catch (err) {
    if (err.status === 503) return res.status(503).json({ error: err.message });
    next(err);
  }
});

/** GET /api/prices/currencies — configured currencies with ISO 4217 minor units. */
router.get('/currencies', (req, res) => {
  res.json({ currencies: getCurrencies() });
});

module.exports = router;
