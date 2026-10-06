exports.up = (pgm) => {
  pgm.addColumns('export_jobs', {
    expires_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('export_jobs', ['expires_at']);
};
