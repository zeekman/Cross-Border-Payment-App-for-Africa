#!/usr/bin/env node
// Fails when a literal t('key') used in src/ is missing from en/translation.json (FE-194).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const en = JSON.parse(fs.readFileSync(path.join(root, 'src/locales/en/translation.json'), 'utf8'));
const lookup = (key) => key.split('.').reduce((o, part) => (o == null ? undefined : o[part]), en);
const exists = (key) => ['', '_zero', '_one', '_two', '_few', '_many', '_other'].some((s) => lookup(key + s) !== undefined);

const missing = new Map();
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) {
      if (name !== '__tests__' && name !== '__mocks__') walk(file);
    } else if (/\.jsx?$/.test(name) && !/\.test\.jsx?$/.test(name)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?<![\w$])t\(\s*(['"`])([\w.-]+)\1/g)) {
        if (!exists(m[2])) missing.set(m[2], path.relative(root, file));
      }
    }
  }
}
walk(path.join(root, 'src'));

if (missing.size) {
  console.error(`${missing.size} translation key(s) missing from en/translation.json:`);
  for (const [key, file] of missing) console.error(`  ${key}  (${file})`);
  process.exit(1);
}
console.log('All translation keys exist in en/translation.json');
