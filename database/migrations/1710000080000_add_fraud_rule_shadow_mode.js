exports.up = (pgm) => {
  // BE-033: per-rule shadow/staging mode. A rule in 'shadow' mode is evaluated
  // and logged like any other rule, but never actually blocks a transaction —
  // it lets a new rule be validated against live traffic before promotion.
  pgm.addColumn('fraud_rules', {
    mode: { type: 'varchar(10)', notNull: true, default: 'active' },
  });
  pgm.addConstraint('fraud_rules', 'fraud_rules_mode_check', "mode IN ('shadow', 'active')");

  // Widen outcome to fit 'shadow_blocked' / 'shadow_passed' and record the
  // rule's mode + what it would have decided, so a false-positive rate can be
  // computed for shadow rules before they are promoted to active.
  pgm.alterColumn('fraud_checks', 'outcome', { type: 'varchar(20)' });
  pgm.addColumn('fraud_checks', {
    rule_mode: { type: 'varchar(10)', notNull: true, default: 'active' },
    would_block: { type: 'boolean' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('fraud_checks', 'rule_mode');
  pgm.dropColumn('fraud_checks', 'would_block');
  pgm.alterColumn('fraud_checks', 'outcome', { type: 'varchar(10)' });
  pgm.dropConstraint('fraud_rules', 'fraud_rules_mode_check');
  pgm.dropColumn('fraud_rules', 'mode');
};
