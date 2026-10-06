/**
 * Defence-in-depth for issue #951: a SEP-31 transaction that has a callback_url
 * must also have a shared_secret, otherwise deliverCallback() would sign the
 * outbound webhook with an empty-string key. The application layer already
 * refuses to create such a row (see sep31Controller.createTransaction), but
 * this constraint guarantees it even against a direct SQL UPDATE or a bug in
 * a future code path.
 */
exports.up = (pgm) => {
  pgm.addConstraint(
    'sep31_transactions',
    'sep31_transactions_callback_requires_secret',
    "CHECK (callback_url IS NULL OR (shared_secret IS NOT NULL AND shared_secret <> ''))"
  );
};

exports.down = (pgm) => {
  pgm.dropConstraint('sep31_transactions', 'sep31_transactions_callback_requires_secret');
};
