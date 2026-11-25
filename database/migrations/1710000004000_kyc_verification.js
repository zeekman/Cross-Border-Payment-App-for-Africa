exports.up = (pgm) => {
  pgm.addColumn("users", {
    kyc_status: {
      type: "varchar(20)",
      notNull: true,
      default: "unverified",
      check: "kyc_status IN ('unverified', 'pending', 'verified', 'rejected')",
    },
    kyc_data: {
      type: "jsonb",
    },
    kyc_submitted_at: {
      type: "timestamptz",
    },
  });

  pgm.createIndex("users", "kyc_status", { name: "idx_users_kyc_status" });
};

exports.down = (pgm) => {
  pgm.dropIndex("users", "kyc_status", { name: "idx_users_kyc_status" });
  pgm.dropColumn("users", "kyc_submitted_at");
  pgm.dropColumn("users", "kyc_data");
  pgm.dropColumn("users", "kyc_status");
};
