exports.up = (pgm) => {
  // Tracks the last successful REFRESH MATERIALIZED VIEW per view, so the
  // API can report how stale the data it just served is.
  pgm.createTable('materialized_view_refreshes', {
    view_name: { type: 'varchar(100)', primaryKey: true },
    refreshed_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('materialized_view_refreshes');
};
