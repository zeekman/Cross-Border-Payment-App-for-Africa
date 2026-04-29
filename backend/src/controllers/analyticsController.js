const db = require('../db');

exports.summary = async (req, res) => {
  try {
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
      [req.user.userId],
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });
    const { public_key } = walletResult.rows[0];

    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setDate(defaultFrom.getDate() - 30);

    const from = req.query.from ? new Date(req.query.from) : defaultFrom;
    const to = req.query.to ? new Date(req.query.to) : now;

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ error: 'Invalid date format; use ISO 8601 (e.g. YYYY-MM-DD)' });
    }
    if (from > to) {
      return res.status(400).json({ error: 'from must be before or equal to to' });
    }

    const walletCondition = '(sender_wallet = $1 OR recipient_wallet = $1)';
    const baseParams = [public_key, from, to];

    const [monthly, topRecipients, assetBreakdown, frequency] = await Promise.all([
      db.query(
        `SELECT DATE_TRUNC('month', created_at) AS month, asset,
                SUM(amount) AS total
         FROM transactions
         WHERE ${walletCondition} AND created_at >= $2 AND created_at <= $3 AND status = 'completed'
         GROUP BY DATE_TRUNC('month', created_at), asset
         ORDER BY month DESC`,
        baseParams,
      ),
      db.query(
        `SELECT recipient_wallet AS recipient_address,
                COUNT(*) AS count,
                SUM(amount) AS total_amount
         FROM transactions
         WHERE sender_wallet = $1 AND created_at >= $2 AND created_at <= $3 AND status = 'completed'
         GROUP BY recipient_wallet
         ORDER BY total_amount DESC
         LIMIT 5`,
        baseParams,
      ),
      db.query(
        `SELECT asset, COUNT(*) AS count, SUM(amount) AS total
         FROM transactions
         WHERE ${walletCondition} AND created_at >= $2 AND created_at <= $3 AND status = 'completed'
         GROUP BY asset`,
        baseParams,
      ),
      db.query(
        `SELECT DATE(created_at) AS date, COUNT(*) AS count
         FROM transactions
         WHERE ${walletCondition} AND created_at >= $2 AND created_at <= $3 AND status = 'completed'
         GROUP BY DATE(created_at)
         ORDER BY date DESC`,
        baseParams,
      ),
    ]);

    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      monthly: monthly.rows,
      top_recipients: topRecipients.rows,
      asset_breakdown: assetBreakdown.rows,
      transaction_frequency: frequency.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
