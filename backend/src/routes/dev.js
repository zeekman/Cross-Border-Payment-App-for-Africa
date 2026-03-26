const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const db = require('../db');

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

module.exports = router;
