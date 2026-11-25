#!/usr/bin/env node
/**
 * Fails the build if a route file registers the same (method, path) more than
 * once. Express keeps only the first matching registration — any later
 * duplicate is silently dead code (see issue #949 / BE-002).
 *
 * Pre-existing duplicates that are tracked as their own issue (not fixed by
 * this check) can be listed in ALLOWLIST below with a comment pointing at the
 * tracking issue, so the build doesn't fail on debt this check didn't create.
 */
const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');

// file (relative to src/routes) -> Set of "METHOD path" pairs known to be
// duplicated already, tracked by a separate issue.
const ALLOWLIST = {};

const ROUTE_CALL_RE = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;

function findDuplicates(filePath, source) {
  const seen = new Map(); // "METHOD path" -> count
  let match;
  ROUTE_CALL_RE.lastIndex = 0;
  while ((match = ROUTE_CALL_RE.exec(source)) !== null) {
    const key = `${match[1].toUpperCase()} ${match[3]}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const fileName = path.basename(filePath);
  const allowed = ALLOWLIST[fileName] || new Set();
  const duplicates = [];
  for (const [key, count] of seen) {
    if (count > 1 && !allowed.has(key)) {
      duplicates.push({ key, count });
    }
  }
  return duplicates;
}

function main() {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
  let failed = false;

  for (const file of files) {
    const filePath = path.join(ROUTES_DIR, file);
    const source = fs.readFileSync(filePath, 'utf8');
    const duplicates = findDuplicates(filePath, source);
    for (const dup of duplicates) {
      failed = true;
      console.error(
        `Duplicate route registration: ${file} registers "${dup.key}" ${dup.count} times. ` +
          `Express only ever dispatches to the first registration — remove the redundant one(s), ` +
          `or add it to ALLOWLIST in scripts/check-duplicate-routes.js with a tracking issue if it's ` +
          `known, pre-existing debt.`
      );
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log(`check-duplicate-routes: OK (${files.length} route files checked)`);
}

main();
