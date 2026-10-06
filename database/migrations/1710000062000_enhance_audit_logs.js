exports.up = async (pgm) => {
  // Add extended columns for full structured audit trail
  pgm.addColumns('audit_logs', {
    actor_role: { type: 'varchar(50)' },
    resource_type: { type: 'varchar(100)' },
    resource_id: { type: 'varchar(255)' },
    old_value: { type: 'jsonb' },
    new_value: { type: 'jsonb' },
  });

  pgm.createIndex('audit_logs', 'action', { name: 'idx_audit_logs_action' });
  pgm.createIndex('audit_logs', 'resource_type', { name: 'idx_audit_logs_resource_type' });
  pgm.createIndex('audit_logs', 'actor_role', { name: 'idx_audit_logs_actor_role' });

  // Enable RLS to make the log tamper-evident.
  // FORCE ROW LEVEL SECURITY ensures even roles with BYPASSRLS are subject to policies.
  // We create SELECT and INSERT policies only — DELETE and UPDATE have no policies,
  // so they are implicitly denied. We also REVOKE the privileges at the table level.
  pgm.sql(`
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

    CREATE POLICY audit_logs_select ON audit_logs
      AS PERMISSIVE FOR SELECT
      USING (true);

    CREATE POLICY audit_logs_insert ON audit_logs
      AS PERMISSIVE FOR INSERT
      WITH CHECK (true);

    REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    GRANT UPDATE, DELETE ON audit_logs TO PUBLIC;
    DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
    DROP POLICY IF EXISTS audit_logs_select ON audit_logs;
    ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
  `);

  pgm.dropIndex('audit_logs', 'actor_role', { name: 'idx_audit_logs_actor_role', ifExists: true });
  pgm.dropIndex('audit_logs', 'resource_type', { name: 'idx_audit_logs_resource_type', ifExists: true });
  pgm.dropIndex('audit_logs', 'action', { name: 'idx_audit_logs_action', ifExists: true });

  pgm.dropColumns('audit_logs', ['actor_role', 'resource_type', 'resource_id', 'old_value', 'new_value']);
};
