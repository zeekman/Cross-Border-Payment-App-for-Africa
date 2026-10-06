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
