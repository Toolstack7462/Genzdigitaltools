'use strict';

/**
 * THE DEPLOY GUARD: a failed check must stop BEFORE live replacement.
 *
 * The 2026-10-21 CRM backend deploy promoted each file and only then ran its syntax check:
 *
 *     base64 -d > "$f.new" && mv "$f.new" "$f" && node -c "$f" && echo ok
 *
 * `node` is not on the remote non-interactive PATH, so every check reported
 * "node: command not found" while the files were ALREADY live. The uploads happened to be valid,
 * but a broken file would have been promoted just the same and the failure noticed afterwards.
 *
 * scripts/crm-deploy-promote.sh inverts the order. These tests run it locally against a temporary
 * tree - no network, no production upload - and prove:
 *   - a syntax error stops promotion and leaves the original file byte-identical;
 *   - a missing runtime stops promotion rather than being ignored;
 *   - a missing staged file stops promotion;
 *   - one bad file in a set blocks the WHOLE set (all-or-nothing);
 *   - a clean set is promoted and backed up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'crm-deploy-promote.sh');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-promote-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'modules'), { recursive: true });
  return { root, app, backup: path.join(root, 'backup') };
}

function stage(app, rel, liveSource, stagedSource) {
  fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
  fs.writeFileSync(path.join(app, rel), liveSource);
  if (stagedSource !== null) fs.writeFileSync(`${path.join(app, rel)}.new`, stagedSource);
}

function run(box, files, env = {}) {
  return spawnSync('sh', [SCRIPT, box.app, box.backup, ...files], {
    encoding: 'utf8',
    env: { ...process.env, CRM_DEPLOY_NODE: process.execPath, CRM_DEPLOY_HTACCESS: '/nonexistent', ...env },
  });
}

const LIVE_OK = 'module.exports = { version: 1 };\n';
const STAGED_OK = 'module.exports = { version: 2 };\n';
const STAGED_BROKEN = 'module.exports = { version: 2,,,\n';   // deliberate syntax error

test('a syntax error stops promotion and leaves the live file untouched', () => {
  const box = sandbox();
  stage(box.app, 'modules/thing.js', LIVE_OK, STAGED_BROKEN);

  const result = run(box, ['modules/thing.js']);

  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /REFUSING TO PROMOTE/);
  // it must fail because the CONTENT does not parse - not because ".new" is an unknown extension,
  // which is how an earlier version of this guard "passed" without checking anything
  assert.ok(!/ERR_UNKNOWN_FILE_EXTENSION/.test(result.stderr), result.stderr);
  assert.match(result.stderr, /SyntaxError|Unexpected token/i, result.stderr);
  assert.equal(fs.readFileSync(path.join(box.app, 'modules/thing.js'), 'utf8'), LIVE_OK,
    'the live file must be byte-identical after a refused promotion');
  assert.ok(fs.existsSync(path.join(box.app, 'modules/thing.js.new')), 'the staged file is left for inspection');
});

test('a missing runtime stops promotion instead of being ignored', () => {
  const box = sandbox();
  stage(box.app, 'modules/thing.js', LIVE_OK, STAGED_OK);

  // exactly the production condition: no node on PATH and none resolvable from configuration
  // Keep exactly the PATH entry that provides `sh`, and drop every entry that provides `node`.
  // The test harness can still spawn a shell while the SCRIPT finds no runtime anywhere - the
  // production condition, where node is absent from the non-interactive PATH.
  const sep = process.platform === 'win32' ? ';' : ':';
  const entries = (process.env.PATH || '').split(sep).filter(Boolean);
  const has = (dir, names) => names.some((n) => { try { fs.accessSync(path.join(dir, n), fs.constants.X_OK); return true; } catch (_) { return false; } });
  const shDirs = entries.filter((d) => has(d, ['sh', 'sh.exe']) && !has(d, ['node', 'node.exe']));
  if (!shDirs.length) { console.log('[skip] no PATH entry provides sh without also providing node'); return; }

  const result = spawnSync('sh', [SCRIPT, box.app, box.backup, 'modules/thing.js'], {
    encoding: 'utf8',
    env: { PATH: shDirs.join(sep), CRM_DEPLOY_HTACCESS: '/nonexistent' },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /no usable node/i);
  assert.equal(fs.readFileSync(path.join(box.app, 'modules/thing.js'), 'utf8'), LIVE_OK);
});

test('a missing staged file stops promotion', () => {
  const box = sandbox();
  stage(box.app, 'modules/thing.js', LIVE_OK, null);
  const result = run(box, ['modules/thing.js']);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(fs.readFileSync(path.join(box.app, 'modules/thing.js'), 'utf8'), LIVE_OK);
});

test('ONE bad file blocks the whole set - no partial deployment', () => {
  const box = sandbox();
  stage(box.app, 'modules/good.js', LIVE_OK, STAGED_OK);
  stage(box.app, 'modules/bad.js', LIVE_OK, STAGED_BROKEN);

  const result = run(box, ['modules/good.js', 'modules/bad.js']);

  assert.equal(result.status, 4, result.stderr);
  assert.equal(fs.readFileSync(path.join(box.app, 'modules/good.js'), 'utf8'), LIVE_OK,
    'the valid file must NOT be promoted while a sibling is broken');
  assert.equal(fs.readFileSync(path.join(box.app, 'modules/bad.js'), 'utf8'), LIVE_OK);
});

test('a clean set is promoted and the previous files are backed up', () => {
  const box = sandbox();
  stage(box.app, 'modules/a.js', LIVE_OK, STAGED_OK);
  stage(box.app, 'modules/b.js', LIVE_OK, STAGED_OK);

  const result = run(box, ['modules/a.js', 'modules/b.js']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(box.app, 'modules/a.js'), 'utf8'), STAGED_OK);
  assert.equal(fs.readFileSync(path.join(box.app, 'modules/b.js'), 'utf8'), STAGED_OK);
  assert.equal(fs.readFileSync(path.join(box.backup, 'modules/a.js'), 'utf8'), LIVE_OK);
  assert.ok(!fs.existsSync(path.join(box.app, 'modules/a.js.new')), 'the staged file is consumed');
  assert.match(result.stdout, /activation is separate/, 'it must not imply the new code is loaded');
});
