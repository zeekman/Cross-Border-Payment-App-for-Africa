const router = require('express').Router();
const { getXlmRates } = require('../services/priceOracle');

router.get('/xlm', async (req, res, next) => {
  try {
    const rates = await getXlmRates();
    const { rate_source, cached_at, stale, ...prices } = rates;
    res.json({
      asset: 'XLM',
      rates: prices,
      rate_source,
      cached_at,
      ...(stale ? { stale: true } : {}),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err.status === 503 && err.body) return res.status(503).json(err.body);
    next(err);
  }
});

module.exports = router;
