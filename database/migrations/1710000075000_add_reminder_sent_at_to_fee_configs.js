exports.up = (pgm) => {
  pgm.addColumn('fee_configs', {
    reminder_sent_at: {
      type: 'timestamptz',
      notNull: false,
      default: null,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('fee_configs', 'reminder_sent_at');
};
