// FE-206 / BE-227: the fiat rate in effect when a transaction was sent, so
// history shows the value at send time rather than today's rate.
// Shape: { rates: { USD, NGN, GHS, KES }, source: 'coingecko', at: ISO timestamp }
exports.up = (pgm) => {
  pgm.addColumns('transactions', { fx_snapshot: { type: 'jsonb' } });
};

exports.down = (pgm) => {
  pgm.dropColumns('transactions', ['fx_snapshot']);
};
