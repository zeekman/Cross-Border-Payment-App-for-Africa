#!/usr/bin/env node
'use strict';

/**
 * Fails if two migration files share the same numeric prefix.
 *
 * Migrations run in lexicographic filename order, so a duplicated prefix
 * makes ordering depend on the slug and can differ between machines.
 *
 * Historical collisions that already ran on real databases are allow-listed
 * below (see database/MIGRATIONS.md). Renaming those files would break the
 * `pgmigrations` history, so they are tolerated here; any *new* collision
 * still fails the check.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'database', 'migrations');

// Prefixes that are known to be duplicated in already-shipped migrations.
// Do NOT add new entries here: create a new migration with a fresh timestamp
// instead (see database/MIGRATIONS.md).
const ALLOWED_DUPLICATE_PREFIXES = new Set([
  '1710000075000', // add_reminder_sent_at_to_fee_configs.js + dispute_evidence.js
  '1710000080000', // add_fraud_rule_shadow_mode.js + add_webauthn_credentials.js
]);

function main() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => /\.(js|sql)$/.test(name))
    .sort();

  const byPrefix = new Map();
  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match) {
      console.error(`Migration file has no numeric prefix: ${file}`);
      process.exitCode = 1;
      continue;
    }
    const prefix = match[1];
    // Legacy 3-digit prefixes (001_..023_) predate the convention; anything
    // newer must be a 13-digit ms epoch or a 14-digit YYYYMMDDHHMMSS stamp.
    if (prefix.length > 3 && prefix.length !== 13 && prefix.length !== 14) {
      console.error(`Migration prefix must be 13 or 14 digits: ${file}`);
      process.exitCode = 1;
    }
    if (/^\s*(BEGIN|COMMIT)\s*;/im.test(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))) {
      console.error(`Migration must not contain its own BEGIN/COMMIT: ${file}`);
      process.exitCode = 1;
    }
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(file);
  }

  let failed = false;
  for (const [prefix, group] of byPrefix) {
    if (group.length < 2) continue;
    if (ALLOWED_DUPLICATE_PREFIXES.has(prefix)) {
      console.warn(
        `Allowing known historical duplicate migration prefix "${prefix}" shared by ${group.length} files: ${group.join(', ')}`
      );
      continue;
    }
    console.error(
      `Duplicate migration prefix "${prefix}" shared by ${group.length} files: ${group.join(', ')}`
    );
    failed = true;
  }

  if (failed || process.exitCode) {
    console.error('\nEach migration must have a unique numeric prefix. See database/MIGRATIONS.md.');
    process.exit(1);
  }

  console.log(`Checked ${files.length} migration files: no unexpected duplicate prefixes.`);
}

main();
