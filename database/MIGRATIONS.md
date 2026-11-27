# Migration naming convention

Files in this directory are run in **lexicographic filename order** by
`node-pg-migrate` (`npm run migrate`, see `backend/package.json`). Every
migration must sort correctly relative to every other migration, or a
migration that depends on an earlier one (e.g. `ALTER TABLE` on a table a
different file creates) can run out of order and fail — or, worse, run in a
different order on different machines.

**Convention:** `<unix-ms-timestamp>_<slug>.{js,sql}` — a 13-digit
millisecond epoch prefix, unique and strictly increasing, followed by a
short descriptive slug.

To create a new migration, use node-pg-migrate's own generator so the
timestamp is filled in automatically and correctly:

```sh
cd backend
npx node-pg-migrate create <short-description> -m ../database/migrations
```

Do not hand-write a numeric prefix (`037_...`, `NNN_...`) or leave a file
unprefixed — both were tried historically in this folder and led to
duplicate prefixes and non-deterministic ordering (fixed in this repo via
a full rename to timestamp prefixes, preserved through `git mv` so file
history/blame is intact — see git log).

CI enforces this: `backend/scripts/check-migration-prefixes.js` fails the
build if any two migration files share a numeric prefix.

## One-time rename note (BE-207)

These files were renamed so every prefix is unique and numeric. Environments
that already ran them under the old name must update `pgmigrations` once,
**before** the next `npm run migrate`:

```sql
UPDATE pgmigrations SET name = '1710000085500_add_transaction_confirmation_expiry'
  WHERE name = '1710000085000_add_transaction_confirmation_expiry';
UPDATE pgmigrations SET name = '20260928140000_add_suspension_indexes'
  WHERE name = '20260928_add_suspension_indexes';
UPDATE pgmigrations SET name = '20261125000000_add_family_id_to_sessions'
  WHERE name = 'add_family_id_to_sessions';
```

Both former `.sql` migrations are now JS with an `exports.down`, and no
migration may contain its own `BEGIN`/`COMMIT` (node-pg-migrate already wraps
each one in a transaction). Prefixes must be 13-digit (ms epoch) or 14-digit
(`YYYYMMDDHHMMSS`); short prefixes like `20260928_` are rejected by CI.
