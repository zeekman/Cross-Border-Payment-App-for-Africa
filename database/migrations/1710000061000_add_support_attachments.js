exports.up = (pgm) => {
  pgm.createTable('support_attachments', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    ticket_id: {
      type: 'integer',
      notNull: true,
      references: '"support_tickets"',
      onDelete: 'CASCADE',
    },
    filename: { type: 'varchar(255)', notNull: true },
    original_name: { type: 'varchar(255)', notNull: true },
    mime_type: { type: 'varchar(100)', notNull: true },
    size_bytes: { type: 'integer', notNull: true },
    storage_path: { type: 'text', notNull: true },
    uploaded_at: { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('support_attachments', 'ticket_id', { name: 'idx_support_attachments_ticket' });
};

exports.down = (pgm) => {
  pgm.dropIndex('support_attachments', 'ticket_id', { name: 'idx_support_attachments_ticket' });
  pgm.dropTable('support_attachments');
};
