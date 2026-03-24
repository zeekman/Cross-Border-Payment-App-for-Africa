exports.up = (pgm) => {
  pgm.addColumn("users", {
    pin_hash: {
      type: "varchar(255)",
      notNull: false,
    },
    pin_setup_completed: {
      type: "boolean",
      notNull: true,
      default: false,
    },
  });

  pgm.createIndex("users", "pin_setup_completed", { name: "idx_users_pin_setup_completed" });
};

exports.down = (pgm) => {
  pgm.dropIndex("users", "pin_setup_completed", { name: "idx_users_pin_setup_completed" });
  pgm.dropColumn("users", "pin_setup_completed");
  pgm.dropColumn("users", "pin_hash");
};
