exports.up = async (pgm) => {
  // CONCURRENTLY cannot run inside a transaction; pgm.sql handles this
  await pgm.sql(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_user_created
     ON payments (user_id, created_at DESC)`
  );
  await pgm.sql(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_status_created
     ON payments (status, created_at DESC)`
  );
  await pgm.sql(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_stellar_tx
     ON payments (stellar_tx_hash)`
  );
  await pgm.sql(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kyc_user_status
     ON kyc_verifications (user_id, status)`
  );
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_payments_user_created');
  await pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_payments_status_created');
  await pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_payments_stellar_tx');
  await pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_kyc_user_status');
};
