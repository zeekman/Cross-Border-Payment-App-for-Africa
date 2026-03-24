exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  pgm.createTable("users", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("uuid_generate_v4()"),
    },
    full_name: { type: "varchar(100)", notNull: true },
    email: { type: "varchar(255)", notNull: true, unique: true },
    password_hash: { type: "varchar(255)", notNull: true },
    phone: { type: "varchar(20)" },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
    updated_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  pgm.createTable("wallets", {
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
    public_key: { type: "varchar(56)", notNull: true, unique: true },
    encrypted_secret_key: { type: "text", notNull: true },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  pgm.createTable("transactions", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("uuid_generate_v4()"),
    },
    sender_wallet: { type: "varchar(56)", notNull: true },
    recipient_wallet: { type: "varchar(56)", notNull: true },
    amount: { type: "decimal(20,7)", notNull: true },
    asset: { type: "varchar(12)", default: "'XLM'" },
    memo: { type: "varchar(28)" },
    tx_hash: { type: "varchar(64)", unique: true },
    status: {
      type: "varchar(20)",
      default: "'pending'",
      check: "status IN ('pending','completed','failed')",
    },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  pgm.createTable("contacts", {
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
    name: { type: "varchar(100)", notNull: true },
    wallet_address: { type: "varchar(56)", notNull: true },
    created_at: { type: "timestamptz", default: pgm.func("NOW()") },
  });

  pgm.addConstraint(
    "contacts",
    "contacts_user_wallet_unique",
    "UNIQUE(user_id, wallet_address)",
  );

  pgm.createIndex("transactions", "sender_wallet", { name: "idx_transactions_sender" });
  pgm.createIndex("transactions", "recipient_wallet", {
    name: "idx_transactions_recipient",
  });
  pgm.createIndex("wallets", "user_id", { name: "idx_wallets_user" });
  pgm.createIndex("contacts", "user_id", { name: "idx_contacts_user" });
};

exports.down = (pgm) => {
  pgm.dropIndex("contacts", "user_id", { name: "idx_contacts_user" });
  pgm.dropIndex("wallets", "user_id", { name: "idx_wallets_user" });
  pgm.dropIndex("transactions", "recipient_wallet", {
    name: "idx_transactions_recipient",
  });
  pgm.dropIndex("transactions", "sender_wallet", { name: "idx_transactions_sender" });

  pgm.dropTable("contacts");
  pgm.dropTable("transactions");
  pgm.dropTable("wallets");
  pgm.dropTable("users");
};
