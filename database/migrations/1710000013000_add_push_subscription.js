/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('users', {
    push_subscription: { type: 'jsonb', default: null },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('users', 'push_subscription');
};
