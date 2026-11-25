// BE-217: durable webhook delivery. An endpoint that keeps failing is disabled
// automatically; these columns track the failure streak and why it was disabled.
exports.up = (pgm) => {
  pgm.addColumns('webhooks', {
    // Events (not attempts) that exhausted every retry since the last success.
    consecutive_failures: { type: 'int', notNull: true, default: 0 },
    disabled_at: { type: 'timestamptz' },
    disabled_reason: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('webhooks', ['consecutive_failures', 'disabled_at', 'disabled_reason']);
};
