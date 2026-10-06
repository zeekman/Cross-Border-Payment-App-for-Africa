const fs = require('fs');
const path = require('path');
const { WEBHOOK_EVENTS } = require('../src/services/webhookEvents');

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every emitted webhook event is in the catalogue', () => {
  const re = /webhook\.deliver\(\s*['"]([\w.]+)['"]/g;
  for (const file of walk(path.join(__dirname, '../src'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, event] of src.matchAll(re)) {
      expect(WEBHOOK_EVENTS).toContain(event);
    }
  }
});
