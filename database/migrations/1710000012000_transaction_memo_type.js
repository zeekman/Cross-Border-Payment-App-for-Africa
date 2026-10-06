exports.up = (pgm) => {
  pgm.addColumn("transactions", {
    memo_type: { type: "varchar(10)", notNull: false },
  });
  pgm.alterColumn("transactions", "memo", {
    type: "varchar(128)",
    notNull: false,
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("transactions", "memo_type");
  pgm.alterColumn("transactions", "memo", {
    type: "varchar(28)",
    notNull: false,
  });
};
