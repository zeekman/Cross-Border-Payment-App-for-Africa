exports.up = (pgm) => {
  pgm.addColumn('agent_escrows', {
    confirmed_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('agent_escrows', 'confirmed_at');
};
