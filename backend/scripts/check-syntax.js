#!/usr/bin/env node
/**
 * BE-191: fails the build if any tracked backend source file does not parse.
 *
 * Runs `node --check` over every `src/**\/*.js` file tracked by git and exits
 * non-zero on the first syntax error. Bad merges have repeatedly left files
 * truncated or with duplicated declarations (BE-143, BE-145, BE-191); this
 * catches them before lint/tests, which would otherwise fail with an opaque
 * module-load error or be skipped entirely.
 */
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');

function listSourceFiles() {
  const out = execFileSync('git', ['ls-files', '--', 'src/**/*.js', 'src/*.js'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
  });
  return [...new Set(out.split('\n').map((f) => f.trim()).filter(Boolean))];
}

function main() {
  const files = listSourceFiles();
  if (files.length === 0) {
    console.error('check-syntax: no files found under src/ — is this a git checkout?');
    process.exit(1);
  }

  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(`check-syntax: ${file} failed to parse\n`);
      console.error(result.stderr || result.stdout || `node --check exited with ${result.status}`);
      process.exit(1);
    }
  }

  console.log(`check-syntax: OK (${files.length} files parsed)`);
}

main();
