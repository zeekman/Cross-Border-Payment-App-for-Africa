/**
 * Analytics Controller
 *
 * `volume` reads from the daily_payment_aggregates materialized view for
 * ranges longer than 7 days (see 026_analytics_materialized_view.js); that
 * view refreshes hourly by default (CRON_ANALYTICS_REFRESH, see
 * backend/src/scheduler.js) or on demand via POST /api/analytics/refresh.
 * Every response includes `refreshed_at` so callers know exactly how stale
 * the data is — see backend/src/services/analyticsRefresh.js for details.
 * `summary` and `fees` always query the live transactions table, so their
 * `refreshed_at` is just the request time.
 */
const db = require('../db');
const { refreshDailyAggregates, getLastRefreshedAt } = require('../services/analyticsRefresh');
const { validateDateRange } = require('../utils/historyQuery');

exports.summary = async (req, res, next) => {
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

    const rangeError = validateDateRange(from, to);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
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
      refreshed_at: new Date().toISOString(), // live query — always current
    });
  } catch (err) {
    next(err);
  }
};

exports.volume = async (req, res, next) => {
  try {
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

    const rangeError = validateDateRange(from, to);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    const rangeDays = Math.ceil((to - from) / (1000 * 60 * 60 * 24));

    let rows;
    let refreshedAt;

    if (rangeDays > 7) {
      // Use the pre-aggregated materialized view for longer ranges to avoid full table scans
      const result = await db.query(
        `WITH date_range AS (
           SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS day
         ),
         asset_list AS (
           SELECT DISTINCT asset FROM daily_payment_aggregates
            WHERE day >= $1::date AND day <= $2::date
         ),
         base AS (
           SELECT dr.day, al.asset FROM date_range dr CROSS JOIN asset_list al
         )
         SELECT
           b.day,
           b.asset,
           COALESCE(a.tx_count, 0)    AS tx_count,
           COALESCE(a.total_amount, 0) AS total_amount,
           COALESCE(a.avg_amount, 0)   AS avg_amount
         FROM base b
         LEFT JOIN daily_payment_aggregates a ON a.day = b.day AND a.asset = b.asset
         ORDER BY b.day ASC, b.asset`,
        [from, to],
      );
      rows = result.rows;
      refreshedAt = (await getLastRefreshedAt()) || null;
    } else {
      // Live query for short ranges (≤ 7 days); generate_series fills zero-count days
      const result = await db.query(
        `WITH date_range AS (
           SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS day
         ),
         asset_list AS (
           SELECT DISTINCT asset FROM transactions
            WHERE created_at >= $1 AND created_at <= $2 AND status = 'completed'
         ),
         base AS (
           SELECT dr.day, al.asset FROM date_range dr CROSS JOIN asset_list al
         ),
         agg AS (
           SELECT DATE(created_at) AS day, asset,
                  COUNT(*)         AS tx_count,
                  SUM(amount)      AS total_amount,
                  AVG(amount)      AS avg_amount
             FROM transactions
            WHERE created_at >= $1 AND created_at <= $2 AND status = 'completed'
            GROUP BY DATE(created_at), asset
         )
         SELECT
           b.day,
           b.asset,
           COALESCE(a.tx_count, 0)    AS tx_count,
           COALESCE(a.total_amount, 0) AS total_amount,
           COALESCE(a.avg_amount, 0)   AS avg_amount
         FROM base b
         LEFT JOIN agg a ON a.day = b.day AND a.asset = b.asset
         ORDER BY b.day ASC, b.asset`,
        [from, to],
      );
      rows = result.rows;
      refreshedAt = new Date().toISOString(); // live query — always current
    }

    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      range_days: rangeDays,
      volume: rows,
      refreshed_at: refreshedAt,
    });
  } catch (err) {
    next(err);
  }
};

exports.fees = async (req, res, next) => {
  try {
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

    const rangeError = validateDateRange(from, to);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    const [totals, byAsset] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(fee_amount), 0) AS total_fees,
                COUNT(*) AS transaction_count
         FROM transactions
         WHERE created_at >= $1 AND created_at <= $2 AND status = 'completed'`,
        [from, to],
      ),
      db.query(
        `SELECT asset,
                COUNT(*) AS transaction_count,
                COALESCE(SUM(fee_amount), 0) AS total_fees,
                COALESCE(AVG(fee_amount), 0) AS avg_fee
         FROM transactions
         WHERE created_at >= $1 AND created_at <= $2 AND status = 'completed'
         GROUP BY asset
         ORDER BY total_fees DESC`,
        [from, to],
      ),
    ]);

    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      total_fees: totals.rows[0].total_fees,
      transaction_count: totals.rows[0].transaction_count,
      by_asset: byAsset.rows,
      refreshed_at: new Date().toISOString(), // live query — always current
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/analytics/refresh
 * Admin-only: triggers an immediate REFRESH MATERIALIZED VIEW CONCURRENTLY
 * for daily_payment_aggregates, ahead of the scheduled cadence. Useful right
 * after a data correction (e.g. reversing a fraudulent transaction) where an
 * admin doesn't want to wait for the next scheduled refresh.
 */
exports.refresh = async (req, res) => {
  try {
    const refreshedAt = await refreshDailyAggregates();
    res.json({ message: 'daily_payment_aggregates refreshed', refreshed_at: refreshedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
