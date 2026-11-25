/**
 * Analytics Materialized View Refresh
 *
 * daily_payment_aggregates (026_analytics_materialized_view.js) is refreshed
 * on a schedule (CRON_ANALYTICS_REFRESH, hourly by default — see
 * backend/src/scheduler.js) and on demand via the admin-only
 * POST /api/analytics/refresh endpoint. Every refresh — scheduled or manual —
 * records its completion time in materialized_view_refreshes so API
 * responses can report how stale the data they served is.
 *
 * Staleness implication: analyticsController.summary/fees always query the
 * live transactions table, so they're never stale. analyticsController.volume
 * falls back to the materialized view for ranges longer than 7 days, so those
 * responses can lag behind live data by up to the refresh interval (or
 * longer, until an admin triggers a manual refresh after e.g. a fraud
 * reversal) — refreshed_at on the response tells the caller exactly how old.
 */

const db = require('../db');

const VIEW_NAME = 'daily_payment_aggregates';

async function refreshDailyAggregates() {
  await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY daily_payment_aggregates');
  const { rows } = await db.query(
    `INSERT INTO materialized_view_refreshes (view_name, refreshed_at)
     VALUES ($1, NOW())
     ON CONFLICT (view_name) DO UPDATE SET refreshed_at = NOW()
     RETURNING refreshed_at`,
    [VIEW_NAME],
  );
  return rows[0].refreshed_at;
}

async function getLastRefreshedAt() {
  const { rows } = await db.query(
    `SELECT refreshed_at FROM materialized_view_refreshes WHERE view_name = $1`,
    [VIEW_NAME],
  );
  return rows[0]?.refreshed_at || null;
}

module.exports = { refreshDailyAggregates, getLastRefreshedAt };
