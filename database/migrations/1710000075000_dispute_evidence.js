exports.up = (pgm) => {
  pgm.createTable('dispute_evidence', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    dispute_id: {
      type: 'uuid',
      notNull: true,
      references: 'disputes',
      onDelete: 'CASCADE',
    },
    uploader_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
    },
    file_path: {
      type: 'text',
      notNull: true,
    },
    sha256_hash: {
      type: 'varchar(64)',
      notNull: true,
    },
    description: {
      type: 'text',
    },
    uploaded_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('dispute_evidence', 'dispute_id');
  pgm.createIndex('dispute_evidence', 'uploader_id');
  pgm.createIndex('dispute_evidence', 'sha256_hash');
};

exports.down = (pgm) => {
  pgm.dropTable('dispute_evidence');
};