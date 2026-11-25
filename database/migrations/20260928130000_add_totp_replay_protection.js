exports.up = (pgm) => {
  pgm.createTable(
    "totp_used_counters",
    {
      user_id: {
        type: "uuid",
        notNull: true,
        references: "users(id)",
        onDelete: "cascade",
      },
      counter: { type: "bigint", notNull: true },
      used_at: {
        type: "timestamptz",
        notNull: true,
        default: pgm.func("NOW()"),
      },
    },
    {
      constraints: {
        primaryKey: ["user_id", "counter"],
      },
    },
  );
  pgm.createIndex("totp_used_counters", "used_at");
};

exports.down = (pgm) => {
  pgm.dropTable("totp_used_counters");
};
