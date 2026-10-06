exports.up = (pgm) => {
  // Partial index on the transactions table for completed rows — speeds up analytics range scans
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_created_at_completed
      ON transactions (created_at)
      WHERE status = 'completed';
  `);

  // Materialized view storing pre-aggregated daily totals per asset
  pgm.sql(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS daily_payment_aggregates AS
    SELECT
      DATE_TRUNC('day', created_at)::date AS day,
      asset,
      COUNT(*)                            AS tx_count,
      SUM(amount)                         AS total_amount,
      AVG(amount)                         AS avg_amount
    FROM transactions
    WHERE status = 'completed'
    GROUP BY DATE_TRUNC('day', created_at)::date, asset
    WITH DATA;
  `);

  // Unique index enables CONCURRENTLY refresh without blocking reads
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_payment_aggregates_day_asset
      ON daily_payment_aggregates (day, asset);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP MATERIALIZED VIEW IF EXISTS daily_payment_aggregates;');
  pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_created_at_completed;');
};
