// BE-204: support_tickets.transaction_id / user_id must be UUIDs to match
// transactions.id and users.id.
// BE-205: support_messages thread + assignment / lifecycle columns.
exports.up = (pgm) => {
  pgm.sql(`
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'support_tickets' AND column_name = 'transaction_id') <> 'uuid' THEN
    ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_transaction_id_fkey;
    ALTER TABLE support_tickets ALTER COLUMN transaction_id TYPE uuid USING NULL;
    ALTER TABLE support_tickets
      ADD CONSTRAINT support_tickets_transaction_id_fkey
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'support_tickets' AND column_name = 'user_id') <> 'uuid' THEN
    -- Integer user ids can never have matched users.id (UUID); such rows are orphans.
    DELETE FROM support_tickets;
    ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_user_id_fkey;
    ALTER TABLE support_tickets ALTER COLUMN user_id TYPE uuid USING NULL;
    ALTER TABLE support_tickets
      ADD CONSTRAINT support_tickets_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
  `);

  pgm.addColumns('support_tickets', {
    assigned_to: { type: 'uuid', references: '"users"', onDelete: 'SET NULL' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' },
    closed_at: { type: 'timestamptz' },
  }, { ifNotExists: true });

  pgm.createTable('support_messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    ticket_id: { type: 'integer', notNull: true, references: '"support_tickets"', onDelete: 'CASCADE' },
    author_id: { type: 'uuid', references: '"users"', onDelete: 'SET NULL' },
    author_role: { type: 'varchar(10)', notNull: true, check: "author_role IN ('user', 'admin')" },
    body: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, { ifNotExists: true });
  pgm.createIndex('support_messages', ['ticket_id', 'created_at'], { ifNotExists: true });
  pgm.createIndex('support_tickets', ['status', 'created_at'], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropIndex('support_tickets', ['status', 'created_at'], { ifExists: true });
  pgm.dropTable('support_messages', { ifExists: true });
  pgm.dropColumns('support_tickets', ['assigned_to', 'updated_at', 'resolved_at', 'closed_at'], { ifExists: true });
};
