/**
 * FE-198 guard: background polling in pages/ and hooks/ must go through
 * useVisibleInterval so it pauses while the tab is hidden. A raw setInterval
 * here keeps fetching in the background and burns mobile data and battery.
 *
 * (.eslintrc.js flags the same thing, but CI lints with a correctness-only
 * config, so this test is what actually fails the build.)
 */
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');
const GUARDED_FOLDERS = ['pages', 'hooks'];
// The one place a raw interval is allowed: the hook that wraps it.
const ALLOWED = new Set([path.join('hooks', 'useVisibleInterval.js')]);

/** Line numbers (1-based) where `source` calls setInterval, ignoring comments. */
export function findRawSetInterval(source) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return; // whole-line comment
    const code = line.replace(/\/\/.*$/, '');
    if (/\bsetInterval\s*\(/.test(code)) hits.push(index + 1);
  });
  return hits;
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.(js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

describe('findRawSetInterval', () => {
  test('flags raw and window-qualified calls', () => {
    expect(findRawSetInterval('const id = setInterval(tick, 1000);')).toEqual([1]);
    expect(findRawSetInterval('a();\nwindow.setInterval(() => {}, 5);')).toEqual([2]);
    expect(findRawSetInterval('x = setInterval (f, 1)')).toEqual([1]);
  });

  test('ignores the hook, clearInterval and comments', () => {
    expect(findRawSetInterval('useVisibleInterval(fn, 1000);')).toEqual([]);
    expect(findRawSetInterval('clearInterval(id);')).toEqual([]);
    expect(findRawSetInterval('// replaces setInterval(poll, 1)')).toEqual([]);
    expect(findRawSetInterval(' * old setInterval(poll, 1) loop')).toEqual([]);
    expect(findRawSetInterval('run(); // was setInterval(poll, 1)')).toEqual([]);
  });
});

describe('background polling', () => {
  test('pages and hooks use useVisibleInterval, not raw setInterval', () => {
    const offenders = [];
    GUARDED_FOLDERS.forEach((folder) => {
      sourceFiles(path.join(SRC, folder)).forEach((file) => {
        const relative = path.relative(SRC, file);
        if (ALLOWED.has(relative)) return;
        findRawSetInterval(fs.readFileSync(file, 'utf8')).forEach((line) => {
          offenders.push(`${relative}:${line}`);
        });
      });
    });
    expect(offenders).toEqual([]);
  });
});
