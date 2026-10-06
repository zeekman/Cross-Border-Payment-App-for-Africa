/* eslint-disable camelcase */

// NOTE: This migration is a duplicate of the earlier SQL migration
// `1710000011000_transaction_memo_type.sql`, which already adds the
// `transactions.memo_type` column. Both files are kept in the chain for
// migration-history compatibility, so this port must be idempotent to avoid
// `column "memo_type" of relation "transactions" already exists` on fresh
// databases. See database/MIGRATIONS.md for guidance on porting `.sql`
// migrations without duplicating them.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn(
    'transactions',
    {
      memo_type: {
        type: 'varchar(255)',
        notNull: false,
      },
    },
    { ifNotExists: true }
  );
};

exports.down = (pgm) => {
  pgm.dropColumn('transactions', 'memo_type', { ifExists: true });
};
