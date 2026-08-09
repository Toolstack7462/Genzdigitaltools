/**
 * 3.9.16 REGRESSION GUARD — the extension must never again freeze a host page's globals.
 *
 * 3.9.15 shipped js/claudeEnforcer.js, which redefined window.fetch, XMLHttpRequest.prototype
 * .open/.send, navigator.sendBeacon and Storage.prototype.setItem as non-configurable and
 * non-writable on claude.ai. Any library that wraps fetch or XHR — telemetry, session replay,
 * error reporting, all normal in a production SPA — then threw:
 *
 *   TypeError: Cannot redefine property: fetch
 *   TypeError: Cannot assign to read only property 'open' of object '[object Object]'
 *
 * Claude's bundle is ES modules (always strict), so even plain assignment threw. The uncaught
 * TypeError killed the bootstrap at document_start and claude.ai/new hung on a blank page.
 *
 * These tests are cheap and blunt on purpose: they fail if anyone reintroduces that shape.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const jsFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) jsFiles.push(p);
  }
})(path.join(EXT, 'js'));

const rel = (p) => path.relative(EXT, p).replace(/\\/g, '/');

test('the 3.9.15 MAIN-world enforcer is gone', () => {
  assert.ok(!fs.existsSync(path.join(EXT, 'js', 'claudeEnforcer.js')),
    'js/claudeEnforcer.js must not exist — it is what broke claude.ai bootstrap');
});

test('nothing registers a MAIN-world content script', () => {
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    // Match the ACTUAL registering calls only. A bare /registerContentScripts/ also matches
    // `unregisterContentScripts`, which is the fix, not the defect.
    assert.ok(!/\.(register|update)ContentScripts\s*\(/.test(src),
      `${rel(f)} registers a content script; MAIN-world injection on a third-party origin is what caused the 3.9.15 outage`);
    assert.ok(!/world:\s*['"]MAIN['"]/.test(src), `${rel(f)} requests MAIN world`);
  }
});

test('no host global is made non-configurable or non-writable', () => {
  // The precise defect: defineProperty on a host global WITHOUT configurable:true.
  const GLOBALS = /(window|globalThis|self)\s*,\s*['"](fetch|XMLHttpRequest)['"]|XMLHttpRequest\.prototype|Storage\.prototype|navigator\s*,\s*['"]sendBeacon['"]/;
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (!/Object\.defineProperty/.test(stripped)) continue;
    for (const m of stripped.split('Object.defineProperty').slice(1)) {
      const head = m.slice(0, 300);
      if (!GLOBALS.test(head)) continue;
      assert.ok(!/configurable:\s*false/.test(head),
        `${rel(f)} makes a host global non-configurable — this is the exact 3.9.15 bootstrap-killer`);
      assert.ok(!/writable:\s*false/.test(head),
        `${rel(f)} makes a host global non-writable — throws on assignment in strict mode`);
    }
  }
});

test('the stale 3.9.15 registration is explicitly torn down on install AND startup', () => {
  const bg = fs.readFileSync(path.join(EXT, 'js', 'background.js'), 'utf8');
  assert.match(bg, /unregisterContentScripts/,
    'background.js must unregister the persisted 3.9.15 script — it survives the update otherwise');
  assert.match(bg, /genz-claude-policy/, 'the exact 3.9.15 registration id must be targeted');
  const calls = bg.match(/unregisterClaudeEnforcer\(/g) || [];
  assert.ok(calls.length >= 3,
    `expected the teardown to be defined and called from both onInstalled and onStartup (found ${calls.length} references)`);
});

test('manifest is 3.9.16 and permissions are unchanged from 3.9.14', () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.strictEqual(m.version, '3.9.16');
  assert.deepStrictEqual(
    m.permissions.slice().sort(),
    ['alarms', 'cookies', 'management', 'notifications', 'scripting', 'storage', 'tabs'],
    'a permission change would force re-consent on upgrade');
  assert.ok(!m.permissions.includes('declarativeNetRequest'), 'no new request-blocking permission');
});
