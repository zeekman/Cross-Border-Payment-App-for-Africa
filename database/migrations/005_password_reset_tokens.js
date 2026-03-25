exports.up = (pgm) => {
  pgm.createTable("password_reset_tokens", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("uuid_generate_v4()"),
    },
    user_id: {
      type: "uuid",
      notNull: true,
      references: '"users"',
      onDelete: "CASCADE",
    },
    token_hash: { type: "varchar(64)", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
    used_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  pgm.createIndex("password_reset_tokens", "user_id", {
    name: "idx_password_reset_tokens_user",
  });

  pgm.sql(`
    CREATE INDEX idx_password_reset_tokens_active
    ON password_reset_tokens(token_hash)
    WHERE used_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP INDEX IF EXISTS idx_password_reset_tokens_active;");
  pgm.dropIndex("password_reset_tokens", "user_id", {
    name: "idx_password_reset_tokens_user",
  });
  pgm.dropTable("password_reset_tokens");
};
