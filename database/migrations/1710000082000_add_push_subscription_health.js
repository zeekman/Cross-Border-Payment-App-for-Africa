/**
 * BE-022: track push-subscription delivery health so a repeatedly-failing
 * subscription can be deactivated (not deleted) and surfaced to the
 * frontend for re-prompting, instead of being retried forever.
 */

exports.up = (pgm) => {
  pgm.addColumns('users', {
    push_failure_count: { type: 'integer', notNull: true, default: 0 },
    push_subscription_active: { type: 'boolean', notNull: true, default: true },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['push_failure_count', 'push_subscription_active']);
};
