exports.up = (pgm) => {
  pgm.addColumns('contacts', {
    notes:         { type: 'text',    notNull: false },
    memo_required: { type: 'boolean', notNull: true, default: false },
    default_memo:  { type: 'varchar(64)', notNull: false },
    tags:          { type: 'text[]', notNull: true, default: "'{}'" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('contacts', ['notes', 'memo_required', 'default_memo', 'tags']);
};
