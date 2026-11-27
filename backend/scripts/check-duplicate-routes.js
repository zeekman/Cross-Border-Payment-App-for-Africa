#!/usr/bin/env node
/**
 * Fails the build if a route file registers the same (method, path) more than
 * once. Express keeps only the first matching registration — any later
 * duplicate is silently dead code (see issue #949 / BE-002).
 *
 * It also fails if src/app.js mounts the same router on the same prefix more
 * than once (BE-192). Express dispatches to the first matching mount, so a
 * second `app.use('/api/wallet', geoRestriction, walletRoutes)` after an
 * unguarded `app.use('/api/wallet', walletRoutes)` is dead code and the
 * middleware it was meant to add (geo-restriction) is silently bypassed.
 *
 * Pre-existing duplicates that are tracked as their own issue (not fixed by
 * this check) can be listed in ALLOWLIST below with a comment pointing at the
 * tracking issue, so the build doesn't fail on debt this check didn't create.
 */
const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const APP_FILE = path.join(__dirname, '..', 'src', 'app.js');

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

/**
 * Return the argument list source of every `app.use(...)` call, found by
 * matching parentheses so inline middleware (arrow functions, objects) does
 * not end the call early. String and template literals are skipped so a `)`
 * inside a string does not unbalance the scan.
 */
function extractAppUseCalls(source) {
  const calls = [];
  const re = /\bapp\.use\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    let quote = null;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
    }
    calls.push({ args: source.slice(re.lastIndex, i - 1), index: m.index });
    re.lastIndex = i;
  }
  return calls;
}

/** Split an argument list on top-level commas. */
function splitTopLevel(args) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(args.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * Find routers mounted more than once on the same prefix in app.js.
 * Only mounts whose first argument is a string literal and whose last
 * argument is a bare identifier (the router) are considered.
 */
function findDuplicateMounts(source) {
  const seen = new Map(); // "prefix router" -> [line numbers]
  for (const { args, index } of extractAppUseCalls(source)) {
    const parts = splitTopLevel(args);
    if (parts.length < 2) continue;
    const prefixMatch = /^(['"`])([^'"`]+)\1$/.exec(parts[0]);
    const routerMatch = /^[A-Za-z_$][\w$]*$/.exec(parts[parts.length - 1]);
    if (!prefixMatch || !routerMatch) continue;
    const key = `${prefixMatch[2]} ${routerMatch[0]}`;
    const line = source.slice(0, index).split('\n').length;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(line);
  }
  const duplicates = [];
  for (const [key, lines] of seen) {
    if (lines.length > 1) {
      const [prefix, router] = key.split(' ');
      duplicates.push({ prefix, router, lines });
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

  if (fs.existsSync(APP_FILE)) {
    const appSource = fs.readFileSync(APP_FILE, 'utf8');
    for (const dup of findDuplicateMounts(appSource)) {
      failed = true;
      console.error(
        `Duplicate router mount: src/app.js mounts ${dup.router} on "${dup.prefix}" ` +
          `${dup.lines.length} times (lines ${dup.lines.join(', ')}). Express dispatches to the ` +
          `first matching mount, so later mounts — and any middleware only they add, such as ` +
          `geoRestriction — never run. Keep a single mount with the full middleware chain.`
      );
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log(`check-duplicate-routes: OK (${files.length} route files and src/app.js mounts checked)`);
}

main();
