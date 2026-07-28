'use strict';
/**
 * The deploy manifest must ship every module the gateway actually requires.
 *
 * WHY THIS TEST EXISTS. `deploy-claude-gateway.sh` uploads an EXPLICIT file list. If a new
 * `lib/*.js` is added and require()d by server.js but not added to that list, every local test
 * still passes — and Passenger then boots into "Cannot find module './lib/<name>'", taking the
 * whole Claude tool down. This is the one class of defect the rest of the suite is structurally
 * unable to catch, because it is a property of the DEPLOY script, not of the code.
 *
 * It has bitten this project before (backend/middleware/rateLimiter.js was missing from
 * deploy-hostinger.sh, which booted the API into "gatewayServiceLimiter is not a function").
 *
 * The test is deliberately dumb and textual: it re-derives the requires from source rather than
 * trusting a hand-maintained list, so it keeps working when someone adds a module and forgets.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const GW = path.join(__dirname, '..');
const DEPLOY = path.join(GW, '..', 'deploy-claude-gateway.sh');

/** Every './lib/x' server.js pulls in at runtime. */
function requiredLibs(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  const re = /require\(\s*['"]\.\/(lib\/[\w.-]+?)(?:\.js)?['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1] + '.js');
  return out;
}

/** The FILES=( ... ) array from the deploy script. */
function manifest() {
  const sh = fs.readFileSync(DEPLOY, 'utf8');
  const m = sh.match(/FILES=\(([\s\S]*?)\)/);
  assert.ok(m, 'deploy-claude-gateway.sh must declare a FILES=( ... ) array');
  return new Set(
    m[1].split(/\s+/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  );
}

test('every lib/ module server.js requires is in the deploy manifest', () => {
  const needed = requiredLibs(path.join(GW, 'server.js'));
  const shipped = manifest();
  assert.ok(needed.size >= 5, 'sanity: the require scan found the modules (' + [...needed].join(', ') + ')');
  const missing = [...needed].filter((f) => !shipped.has(f));
  assert.deepStrictEqual(missing, [],
    'these are require()d but would NOT be uploaded — Passenger would boot into "Cannot find module": ' + missing.join(', '));
});

test('transitive lib requires are shipped too', () => {
  // A shipped module that requires ANOTHER lib module drags it in — effortPrefs requires
  // effortPolicy, and missing that would fail on boot just as hard.
  const shipped = manifest();
  for (const f of [...shipped].filter((f) => f.startsWith('lib/'))) {
    const abs = path.join(GW, f);
    if (!fs.existsSync(abs)) continue;
    for (const dep of requiredLibs(abs)) {
      assert.ok(shipped.has(dep), f + ' requires ' + dep + ', which is not in the deploy manifest');
    }
  }
});

test('the manifest ships only files that exist, and never a test file or a secret', () => {
  for (const f of manifest()) {
    assert.ok(fs.existsSync(path.join(GW, f)), 'manifest lists a file that does not exist: ' + f);
    assert.ok(!/\.test\.js$/.test(f), 'test files must never be deployed: ' + f);
    assert.ok(!/^\.env|\.example$/.test(f), 'secrets/templates must never be deployed: ' + f);
  }
});
