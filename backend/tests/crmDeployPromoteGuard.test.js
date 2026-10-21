'use strict';

/**
 * THE DEPLOY GUARD. Two things must hold:
 *
 *   (a) a failed CHECK must stop before any live replacement, and
 *   (b) a failed PROMOTION must not leave a mixed patch set.
 *
 * (a) was the 2026-10-21 defect. The deploy ran, per uploaded file:
 *
 *     base64 -d > "$f.new" && mv "$f.new" "$f" && node -c "$f" && echo ok
 *
 * The `mv` came first, so each file was already live when its check ran - and `node` is absent
 * from the remote non-interactive PATH, so every check reported "node: command not found" against
 * files that had already replaced the originals. (A later `node --check "$f.new"` form fails for a
 * different reason: `--check` rejects an unknown EXTENSION before parsing anything, so it is a
 * check that cannot pass, not one that lets bad code through. The defect was the ORDER.)
 *
 * (b) survived that fix. Validation stops nothing once promotion starts: with two files, the first
 * `mv` succeeding and the second failing left ONE NEW and ONE OLD file and merely exited non-zero.
 * Independent local execution of blob 54df6590ddc49cd84150673f160aa1cf054ed1a5 confirmed exactly
 * that. The tests in "partial failure" below reproduce it and are the ones that fail against that
 * blob.
 *
 * The script now also takes an exclusive lock, so two releases cannot interleave renames on the
 * same files, and it states plainly that it is NOT crash-atomic - a SIGKILL between two renames
 * cannot be undone by the process that is gone. The leftover lock + journal is the detection
 * signal, and that is asserted here too.
 *
 * Faults are injected through CRM_DEPLOY_MV / CRM_DEPLOY_ROLLBACK_CP, which exist only so a test
 * can fail an exact step; the script carries no fault logic of its own. All of this runs against a
 * temporary tree - no network, no production upload.
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
  if (liveSource !== null) fs.writeFileSync(path.join(app, rel), liveSource);
  if (stagedSource !== null) fs.writeFileSync(`${path.join(app, rel)}.new`, stagedSource);
}

function run(box, files, env = {}) {
  return spawnSync('sh', [SCRIPT, box.app, box.backup, ...files], {
    encoding: 'utf8',
    env: { ...process.env, CRM_DEPLOY_NODE: process.execPath, CRM_DEPLOY_HTACCESS: '/nonexistent', ...env },
  });
}

/**
 * A stand-in for `mv` that succeeds `okCount` times and then fails - the real partial-failure
 * shape (a full disk, a permission change, a vanished directory partway through a set).
 */
function flakyCommand(box, name, okCount, real) {
  const counter = path.join(box.root, `${name}.count`);
  const file = path.join(box.root, `${name}.sh`);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
    'n=$((n+1))',
    `printf %s "$n" > "${counter}"`,
    `if [ "$n" -le ${okCount} ]; then exec ${real} "$@"; fi`,
    `echo "injected ${name} failure (call $n)" >&2`,
    'exit 1',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  return `sh ${file}`;
}

const read = (p) => fs.readFileSync(p, 'utf8');
const LIVE_OK = 'module.exports = { version: 1 };\n';
const STAGED_OK = 'module.exports = { version: 2 };\n';
const STAGED_BROKEN = 'module.exports = { version: 2,,,\n';   // deliberate syntax error

// ── validation: nothing may be replaced before every check passes ─────────────────────────────

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
  assert.equal(read(path.join(box.app, 'modules/thing.js')), LIVE_OK,
    'the live file must be byte-identical after a refused promotion');
  assert.ok(fs.existsSync(path.join(box.app, 'modules/thing.js.new')), 'the staged file is left for inspection');
});

test('a missing runtime stops promotion instead of being ignored', () => {
  const box = sandbox();
  stage(box.app, 'modules/thing.js', LIVE_OK, STAGED_OK);

  // exactly the production condition: no node on PATH and none resolvable from configuration.
  // Keep exactly the PATH entry that provides `sh`, and drop every entry that provides `node`.
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
  assert.equal(read(path.join(box.app, 'modules/thing.js')), LIVE_OK);
});

test('a missing staged file stops promotion', () => {
  const box = sandbox();
  stage(box.app, 'modules/thing.js', LIVE_OK, null);
  const result = run(box, ['modules/thing.js']);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(read(path.join(box.app, 'modules/thing.js')), LIVE_OK);
});

test('ONE bad file blocks the whole set - no partial deployment', () => {
  const box = sandbox();
  stage(box.app, 'modules/good.js', LIVE_OK, STAGED_OK);
  stage(box.app, 'modules/bad.js', LIVE_OK, STAGED_BROKEN);

  const result = run(box, ['modules/good.js', 'modules/bad.js']);

  assert.equal(result.status, 4, result.stderr);
  assert.equal(read(path.join(box.app, 'modules/good.js')), LIVE_OK,
    'the valid file must NOT be promoted while a sibling is broken');
  assert.equal(read(path.join(box.app, 'modules/bad.js')), LIVE_OK);
});

test('a clean set is promoted and the previous files are backed up', () => {
  const box = sandbox();
  stage(box.app, 'modules/a.js', LIVE_OK, STAGED_OK);
  stage(box.app, 'modules/b.js', LIVE_OK, STAGED_OK);

  const result = run(box, ['modules/a.js', 'modules/b.js']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(path.join(box.app, 'modules/a.js')), STAGED_OK);
  assert.equal(read(path.join(box.app, 'modules/b.js')), STAGED_OK);
  assert.equal(read(path.join(box.backup, 'modules/a.js')), LIVE_OK);
  assert.ok(!fs.existsSync(path.join(box.app, 'modules/a.js.new')), 'the staged file is consumed');
  assert.match(result.stdout, /activation is separate/, 'it must not imply the new code is loaded');
  assert.ok(!fs.existsSync(path.join(box.app, '.crm-promote.lock')), 'the lock is released on success');
});

// ── partial failure: the boundary that survived the first fix ─────────────────────────────────

test('PARTIAL FAILURE: the first file promotes, the second cannot - the set must not stay mixed', () => {
  const box = sandbox();
  stage(box.app, 'modules/a.js', LIVE_OK, STAGED_OK);
  stage(box.app, 'modules/b.js', LIVE_OK, STAGED_OK);

  const result = run(box, ['modules/a.js', 'modules/b.js'],
    { CRM_DEPLOY_MV: flakyCommand(box, 'mv', 1, 'mv') });

  assert.equal(result.status, 6, result.stderr);
  assert.match(result.stderr, /PROMOTION FAILED on modules\/b\.js/);
  assert.match(result.stderr, /Rolled back/);

  // THE POINT: a.js was already replaced, and must have been put back
  assert.equal(read(path.join(box.app, 'modules/a.js')), LIVE_OK,
    'the file that DID promote must be restored - otherwise the tree is a mixed patch set');
  assert.equal(read(path.join(box.app, 'modules/b.js')), LIVE_OK);

  // the new content is not thrown away: both files are staged again, so the release can be retried
  assert.equal(read(path.join(box.app, 'modules/a.js.new')), STAGED_OK);
  assert.equal(read(path.join(box.app, 'modules/b.js.new')), STAGED_OK);

  // backups survive, and nothing invites activation
  assert.equal(read(path.join(box.backup, 'modules/a.js')), LIVE_OK);
  assert.match(result.stderr, /DO NOT touch tmp\/restart\.txt/);
  assert.ok(!fs.existsSync(path.join(box.app, '.crm-promote.lock')));
});

test('PARTIAL FAILURE: a file with no original is removed again, not left behind', () => {
  const box = sandbox();
  stage(box.app, 'modules/fresh.js', null, STAGED_OK);     // brand new file, nothing to back up
  stage(box.app, 'modules/b.js', LIVE_OK, STAGED_OK);

  const result = run(box, ['modules/fresh.js', 'modules/b.js'],
    { CRM_DEPLOY_MV: flakyCommand(box, 'mv', 1, 'mv') });

  assert.equal(result.status, 6, result.stderr);
  assert.ok(!fs.existsSync(path.join(box.app, 'modules/fresh.js')),
    'a new file with no backup must be withdrawn, or the app sees half a release');
  assert.equal(read(path.join(box.app, 'modules/fresh.js.new')), STAGED_OK, 'its content is still staged');
  assert.equal(read(path.join(box.app, 'modules/b.js')), LIVE_OK);
});

test('PARTIAL FAILURE: when the ROLLBACK itself fails, say MIXED STATE and name the files', () => {
  const box = sandbox();
  stage(box.app, 'modules/a.js', LIVE_OK, STAGED_OK);
  stage(box.app, 'modules/b.js', LIVE_OK, STAGED_OK);

  const result = run(box, ['modules/a.js', 'modules/b.js'], {
    CRM_DEPLOY_MV: flakyCommand(box, 'mv', 1, 'mv'),
    CRM_DEPLOY_ROLLBACK_CP: flakyCommand(box, 'rbcp', 0, 'cp'),   // every restore attempt fails
  });

  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, /MIXED STATE/);
  assert.match(result.stderr, /modules\/a\.js/, 'the file left in the wrong state must be named');
  assert.match(result.stderr, /Restore them from .* by hand/);
  assert.match(result.stderr, /DO NOT touch tmp\/restart\.txt/,
    'a mixed set must never be activated - that is the difference between recoverable and an outage');
  assert.equal(read(path.join(box.backup, 'modules/a.js')), LIVE_OK, 'the backup must survive for that recovery');
});

// ── concurrency and crash evidence ────────────────────────────────────────────────────────────

test('a second concurrent release is refused rather than racing the same files', () => {
  const box = sandbox();
  stage(box.app, 'modules/a.js', LIVE_OK, STAGED_OK);
  fs.mkdirSync(path.join(box.app, '.crm-promote.lock'));
  fs.writeFileSync(path.join(box.app, '.crm-promote.lock', 'owner'), 'pid 4242 at 2026-10-21T20:00:00Z\n');

  const result = run(box, ['modules/a.js']);

  assert.equal(result.status, 5, result.stderr);
  assert.match(result.stderr, /another promotion holds/);
  assert.match(result.stderr, /pid 4242/, 'it must say who holds it');
  assert.equal(read(path.join(box.app, 'modules/a.js')), LIVE_OK, 'nothing may be promoted while locked');
  assert.ok(fs.existsSync(path.join(box.app, '.crm-promote.lock')), 'it must not steal or clear the other lock');
});

test('a lock left by a killed run reports WHICH files were already replaced', () => {
  const box = sandbox();
  stage(box.app, 'modules/a.js', LIVE_OK, STAGED_OK);
  const lock = path.join(box.app, '.crm-promote.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'promoted'), 'modules/already.js\n');

  const result = run(box, ['modules/a.js']);

  assert.equal(result.status, 5, result.stderr);
  assert.match(result.stderr, /may be MIXED/);
  assert.match(result.stderr, /modules\/already\.js/,
    'the journal is the only evidence of a crash mid-promotion - it must be surfaced, not swallowed');
});

test('the script does not claim crash-atomicity it cannot provide', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /NOT crash-atomic/, 'the limit must be stated where a deployer will read it');
  assert.match(source, /\.crm-promote\.lock/, 'and the detection signal must be named');
  // the safer path has to be recommended ahead of this helper
  assert.match(source, /PREFER THE ESTABLISHED RELEASE PATH/);
  assert.match(source, /Switching current to the new version|switch the `current` symlink/);
});

test('the fault-injection hooks are inert unless a test sets them', () => {
  const box = sandbox();
  stage(box.app, 'modules/a.js', LIVE_OK, STAGED_OK);
  const result = spawnSync('sh', [SCRIPT, box.app, box.backup, 'modules/a.js'], {
    encoding: 'utf8',
    env: { ...process.env, CRM_DEPLOY_NODE: process.execPath, CRM_DEPLOY_HTACCESS: '/nonexistent' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(path.join(box.app, 'modules/a.js')), STAGED_OK);
});

test('the live file keeps its own mode - a release does not silently change permissions', () => {
  if (process.platform === 'win32') { console.log('[skip] POSIX modes are not meaningful here'); return; }
  const box = sandbox();
  stage(box.app, 'modules/a.js', LIVE_OK, STAGED_OK);
  fs.chmodSync(path.join(box.app, 'modules/a.js'), 0o640);
  fs.chmodSync(path.join(box.app, 'modules/a.js.new'), 0o666);

  assert.equal(run(box, ['modules/a.js']).status, 0);

  assert.equal(fs.statSync(path.join(box.app, 'modules/a.js')).mode & 0o777, 0o640,
    'the promoted file must carry the mode the live file had, not the upload mode');
  assert.equal(fs.statSync(path.join(box.backup, 'modules/a.js')).mode & 0o777, 0o640,
    'and the backup must preserve the original mode too');
});
