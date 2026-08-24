'use strict';
/**
 * CLEAN-ROOM DEPLOY SIMULATION.
 *
 * `deployManifest.test.js` asks a static question: "is every proxy-util require listed somewhere in
 * the script?". This asks the question that actually matters on the server: **after this script
 * runs, does the deployed tree resolve every module it needs — without reaching back into the
 * source worktree?**
 *
 * That distinction is the whole point. The 38-day-outage postmortem turned up eight per-feature
 * scripts that would each have shipped a route without a module it require()s. A test that reads
 * only the script text can miss a transitive dependency (module A ships, A requires B, B requires
 * a NEW module C); a test that builds the tree and resolves from it cannot.
 *
 * How the server state is modelled: these scripts are INCREMENTAL by design — they upload what
 * changed and rely on the server already holding the rest of the tree. So the clean room is
 * seeded with the LAST COMMITTED backend tree (what the server is presumed to hold), the script's
 * uploads are overlaid from the working tree, and resolution runs from there. That is exactly the
 * real deploy, and it is what makes a missing NEW module show up: it exists in neither layer.
 *
 * Resolution is static (no execution): requiring server-crm.js for real would open a DB pool and
 * bind a port. Every relative `require()` is followed transitively from each uploaded entry point;
 * package requires are ignored (node_modules is installed on the server, not shipped by these
 * scripts).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'backend');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Files a deploy script uploads: `-T backend/<path>` plus args handed to deploy-backend.sh. */
function uploadsOf(scriptName) {
  const sh = fs.readFileSync(path.join(ROOT, scriptName), 'utf8');
  const out = new Set();
  let m;
  const reUpload = /-T\s+backend\/([\w./-]+)/g;
  while ((m = reUpload.exec(sh))) out.add(m[1]);
  const reArg = /deploy-backend\.sh\s+([^\n]*)/g;
  while ((m = reArg.exec(sh))) {
    for (const tok of m[1].split(/\s+/)) {
      const t = tok.replace(/\\$/, '').trim();
      if (t.startsWith('backend/')) out.add(t.slice('backend/'.length));
    }
  }
  return [...out];
}

/** Relative requires of a file inside a given tree, resolved to tree-relative paths. */
function requiresIn(treeRoot, rel) {
  const abs = path.join(treeRoot, rel);
  if (!fs.existsSync(abs)) return null;            // caller reports this as unresolvable
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const target = path.resolve(path.dirname(abs), m[1]);
    let hit = null;
    for (const cand of [target, target + '.js', path.join(target, 'index.js')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { hit = cand; break; }
    }
    out.push({ spec: m[1], resolved: hit ? path.relative(treeRoot, hit).split(path.sep).join('/') : null });
  }
  return out;
}

/**
 * Layer 1, built ONCE and reused: the committed backend tree at HEAD~1 — what the live server is
 * presumed to already hold. HEAD~1 rather than HEAD is deliberate: it leaves this branch's NEW
 * modules out of the baseline, which is exactly the condition that breaks a real deploy.
 *
 * Materialised by streaming every blob through ONE `git cat-file --batch` process. The obvious
 * alternatives are both worse here: a `git show` per file spawned several thousand processes and
 * took ~2 minutes (a useful test nobody runs), and `git archive | tar` breaks on this platform
 * because GNU tar reads a `C:\...` path as a remote host.
 */
function buildBaseline(tmpBase) {
  const baseDir = path.join(tmpBase, 'baseline');
  const files = git(['ls-tree', '-r', '--name-only', 'HEAD~1', 'backend/'])
    .split('\n').filter(f => f.endsWith('.js'));

  const input = files.map(f => `HEAD~1:${f}`).join('\n') + '\n';
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: ROOT, input, maxBuffer: 512 * 1024 * 1024,
  });

  // Response per request: "<sha> <type> <size>\n" then <size> raw bytes then "\n".
  let off = 0;
  for (const f of files) {
    const nl = out.indexOf('\n', off);
    if (nl < 0) break;
    const header = out.toString('utf8', off, nl);
    if (/missing$/.test(header)) { off = nl + 1; continue; }
    const size = Number(header.split(' ')[2]);
    const start = nl + 1;
    const dest = path.join(baseDir, f.slice('backend/'.length));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out.subarray(start, start + size));
    off = start + size + 1;
  }
  return baseDir;
}

/**
 * Build the clean room: a copy of the baseline (presumed server state) with this script's uploads
 * overlaid from the working tree. Returns the temp directory.
 */
function buildCleanRoom(scriptName, tmpBase, baseline, i) {
  const room = path.join(tmpBase, 'room-' + i);
  fs.cpSync(baseline, room, { recursive: true });
  for (const rel of uploadsOf(scriptName)) {
    const src = path.join(BACKEND, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(room, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return room;
}

function deployScripts() {
  return fs.readdirSync(ROOT).filter(f => /^deploy.*\.sh$/.test(f) && f !== 'deploy-lib.sh');
}

test('every deploy script produces a tree that resolves all its own modules', (t) => {
  let baseline;
  try { baseline = git(['rev-parse', 'HEAD~1']).trim(); }
  catch (_) { return t.skip('needs at least two commits to model the pre-deploy server state'); }
  assert.ok(baseline, 'baseline commit resolved');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-deploy-'));
  const failures = [];
  try {
    const baseline = buildBaseline(tmpBase);
    let i = 0;
    for (const script of deployScripts()) {
      const uploads = uploadsOf(script).filter(f => f.endsWith('.js'));
      if (!uploads.length) continue;
      const room = buildCleanRoom(script, tmpBase, baseline, i++);

      // Walk every uploaded entry point transitively through the DEPLOYED tree only.
      const seen = new Set();
      const queue = [...uploads];
      while (queue.length) {
        const rel = queue.shift();
        if (seen.has(rel)) continue;
        seen.add(rel);
        const deps = requiresIn(room, rel);
        if (deps === null) { failures.push(`${script}: ${rel} is required but absent from the deployed tree`); continue; }
        for (const d of deps) {
          if (!d.resolved) failures.push(`${script}: ${rel} requires '${d.spec}' which does not exist in the deployed tree`);
          else if (!seen.has(d.resolved)) queue.push(d.resolved);
        }
      }
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  assert.deepStrictEqual(failures, [],
    'a deploy would leave the server unable to resolve a module — Passenger boots into ' +
    '"Cannot find module" and the whole API goes down');
});

test('the clean-room harness actually detects a missing module', () => {
  // A guard for the guard: if the resolver silently resolved everything, the test above would pass
  // no matter what was shipped. Prove it fails when a required module is absent.
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-negative-'));
  try {
    const room = path.join(tmpBase, 'room');
    fs.mkdirSync(path.join(room, 'utils'), { recursive: true });
    fs.writeFileSync(path.join(room, 'entry.js'), "require('./utils/missing');\n");
    const deps = requiresIn(room, 'entry.js');
    assert.strictEqual(deps.length, 1);
    assert.strictEqual(deps[0].resolved, null, 'an absent module must resolve to null, not be skipped');

    fs.writeFileSync(path.join(room, 'utils', 'missing.js'), 'module.exports = {};\n');
    assert.strictEqual(requiresIn(room, 'entry.js')[0].resolved, 'utils/missing.js', 'and must resolve once present');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
