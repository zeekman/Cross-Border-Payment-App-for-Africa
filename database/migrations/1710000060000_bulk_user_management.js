exports.up = (pgm) => {
  pgm.addColumns('users', {
    is_suspended: { type: 'boolean', notNull: true, default: false },
    suspension_reason: { type: 'text' },
    suspended_at: { type: 'timestamptz' },
  });

  pgm.createTable('export_jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    admin_id: { type: 'uuid', notNull: true },
    status: { type: 'varchar(20)', notNull: true, default: "'pending'" },
    operation: { type: 'varchar(50)', notNull: true },
    filters: { type: 'jsonb' },
    download_url: { type: 'text' },
    error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    completed_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('export_jobs', 'export_jobs_status_check',
    "status IN ('pending', 'processing', 'completed', 'failed')");
};

exports.down = (pgm) => {
  pgm.dropTable('export_jobs');
  pgm.dropColumns('users', ['is_suspended', 'suspension_reason', 'suspended_at']);
};
