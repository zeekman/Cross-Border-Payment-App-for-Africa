#!/usr/bin/env node
// Fails when an active e2e spec references a data-testid missing from
// frontend/src or navigates to a route that App.jsx does not define.
const fs = require('fs');
const path = require('path');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(p)) : [p];
});

const config = fs.readFileSync(path.join(__dirname, 'playwright.config.js'), 'utf8');
const active = [...config.matchAll(/testMatch:\s*\[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
const specs = walk(path.join(__dirname, 'tests')).filter((f) => active.includes(path.basename(f)));
const src = walk(path.join(__dirname, '..', 'frontend', 'src'))
  .filter((f) => /\.jsx?$/.test(f) && !/\.test\./.test(f))
  .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'App.jsx'), 'utf8');

const routes = new Set(['', '*']);
for (const m of app.matchAll(/path="([^"]*)"/g)) routes.add(m[1].replace(/^\//, ''));
const routeExists = (url) => {
  const segs = url.replace(/^\//, '').split('?')[0].split('/');
  return [...routes].some((r) => {
    const rs = r.split('/');
    return rs.length === segs.length && rs.every((s, i) => s.startsWith(':') || s === segs[i]);
  });
};

const errors = [];
for (const file of specs) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(__dirname, file);
  for (const m of text.matchAll(/getByTestId\(\s*['"]([\w-]+)['"]|data-testid=["']([\w-]+)["']/g)) {
    const id = m[1] || m[2];
    if (!src.includes(`data-testid="${id}"`) && !src.includes(`data-testid='${id}'`)) {
      errors.push(`${rel}: unknown data-testid "${id}"`);
    }
  }
  for (const m of text.matchAll(/goto\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (!/^https?:/.test(m[1]) && !routeExists(m[1])) errors.push(`${rel}: unknown route "${m[1]}"`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`e2e selectors OK (${specs.length} spec(s))`);
