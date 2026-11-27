/**
 * BE-227: persist the FX rate and fee snapshot on each transaction at send time.
 * BE-225: KYC document retention deadline.
 * Existing rows are backfilled with NULL ("rate unavailable" in the UI).
 */

exports.up = (pgm) => {
  pgm.addColumns('transactions', {
    fx_snapshot: { type: 'jsonb', default: null },
    fee_snapshot: { type: 'jsonb', default: null },
  });
  pgm.sql('UPDATE transactions SET fee_snapshot = fee_breakdown WHERE fee_breakdown IS NOT NULL');
  pgm.addColumns('users', {
    kyc_retain_until: { type: 'timestamptz', default: null },
    kyc_document_deleted_at: { type: 'timestamptz', default: null },
    show_profile_on_requests: { type: 'boolean', notNull: true, default: true },
  });
  pgm.createIndex('users', 'kyc_retain_until', { where: 'kyc_retain_until IS NOT NULL AND kyc_document_deleted_at IS NULL' });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['kyc_retain_until', 'kyc_document_deleted_at', 'show_profile_on_requests']);
  pgm.dropColumns('transactions', ['fx_snapshot', 'fee_snapshot']);
};
