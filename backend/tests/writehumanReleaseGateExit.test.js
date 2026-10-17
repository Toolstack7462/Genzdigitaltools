'use strict';
/**
 * THE RELEASE GATE MUST ACTUALLY BLOCK — asserted at the PROCESS level, by exit code.
 *
 * WHY THIS TEST EXISTS. At b3a6141 `npm run test:release-gate` exited 0 with no installer and no
 * latest.json: one skipped test, zero failures. Both artifact-dependent assertions skipped when the
 * artifact was absent, so the gate could not block the one thing it exists to block — publishing a
 * version with nothing behind it, which is the 2026-08-26 failure exactly. The suite was green, the
 * gate was decorative, and nothing in-process could tell the difference, because a skip IS a pass
 * to every caller that reads `$?`.
 *
 * So this test does not assert on test names or TAP lines. It spawns the gate as a child process
 * against a fixture dist directory and asserts the EXIT CODE, which is the only thing a shell
 * deploy script, CI job or human actually consults.
 *
 * THE FIXTURES ARE SYNTHETIC SEA IMAGES, NOT THE 91 MB INSTALLER. The real exe is gitignored and
 * absent in CI, so these build minimal PE images in the same shape Node's SEA injection produces:
 * MZ/PE headers, a self-consistent PE checksum, and length-prefixed assets. That lets every failure
 * mode — including "stale embedded source", which is otherwise unreachable without rebuilding a
 * 91 MB binary — be exercised deterministically on every pull request.
 */
const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BACKEND = path.join(__dirname, '..');
const ROOT = path.join(BACKEND, '..');
const AGENT_DIR = path.join(ROOT, 'writehuman-v2', 'agent');
const { inspect } = require(path.join(AGENT_DIR, 'tools', 'pe-checksum.cjs'));
const { extract } = require(path.join(AGENT_DIR, 'tools', 'extract-sea.cjs'));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const REAL_AGENT = fs.readFileSync(path.join(AGENT_DIR, 'cookie-sync-agent.js'));
const REAL_BOOTSTRAP = fs.readFileSync(path.join(AGENT_DIR, 'wh-agent-sea.js'));

/** Length-prefixed string, as Node's SEA blob serialises its asset table. */
function lp(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([n, b]);
}

/**
 * A minimal PE32+ image carrying the two SEA assets, with a self-consistent header checksum.
 * Deliberately the same construction the agent package's own extraction test uses, so what is
 * exercised here is the gate, not a bespoke format.
 */
function synthInstaller({ agent = REAL_AGENT, bootstrap = REAL_BOOTSTRAP } = {}) {
  const header = Buffer.alloc(256);
  header.write('MZ', 0);
  header.writeUInt32LE(128, 60);          // e_lfanew
  header.write('PE\0\0', 128);
  header.writeUInt16LE(112, 148);         // sizeOfOptionalHeader (pe+20)
  header.writeUInt16LE(0x20b, 152);       // PE32+ magic (pe+24)
  const count = Buffer.alloc(8);
  count.writeBigUInt64LE(1n);
  const bytes = Buffer.concat([
    header,
    lp('wh-agent-sea.js'), lp(bootstrap),
    count,
    lp('cookie-sync-agent.js'), lp(agent),
  ]);
  const r = inspect(bytes);               // the summation skips the checksum field itself
  bytes.writeUInt32LE(r.computed, r.offset);
  return bytes;
}

function metaFor(bytes, over = {}) {
  const src = extract(bytes).files['cookie-sync-agent.js'].toString('utf8');
  const version = (src.match(/AGENT_VERSION\s*=\s*'([^']+)'/) || [])[1];
  return {
    product: 'WriteHuman Universal Agent',
    file: 'WriteHuman-Agent-Setup-x64.exe',
    version,
    size: bytes.length,
    sha256: sha256(bytes),
    arch: 'x64',
    signed: false,
    ...over,
  };
}

/**
 * Lay out a fixture dist dir and run the gate against it. Returns the child's exit status.
 *
 * `inheritTestContext` reproduces the environment a release gets cut from when something already
 * ran node:test in the same shell — a wrapper script, an IDE task, a CI job that tests before
 * deploying. That is not a contrived case, and it is the one that used to return a false pass.
 */
function runGate({ exe, meta, rawMeta, inheritTestContext = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-gate-'));
  try {
    if (exe) fs.writeFileSync(path.join(dir, 'WriteHuman-Agent-Setup-x64.exe'), exe);
    if (rawMeta !== undefined) fs.writeFileSync(path.join(dir, 'latest.json'), rawMeta);
    else if (meta) fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(meta, null, 2));
    // NODE_TEST_CONTEXT must NOT be inherited. node:test sets it for every file it runs, and a
    // nested `node --test` that sees it believes it is a reporting child of an outer run and exits
    // 0 regardless of its own failures. Leaving it in place made all eleven failure scenarios below
    // read as passes — the exact blindness this file was written to remove.
    const env = { ...process.env, WH_GATE_DIST_DIR: dir };
    // Default: a clean shell. The runner itself is responsible for sanitising its own child, so
    // these tests must be able to hand it a DIRTY environment on purpose.
    if (inheritTestContext) env.NODE_TEST_CONTEXT = 'child-v8';
    else delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [path.join(BACKEND, 'scripts', 'release-gate.cjs')], {
      cwd: BACKEND,
      encoding: 'utf8',
      env,
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── The seven states a candidate dist can be in ─────────────────────────────────────────────────

test('BOTH MISSING: an empty dist directory blocks the release', () => {
  const { status, out } = runGate({});
  assert.notStrictEqual(status, 0, 'an empty dist must NOT exit 0 — this is the bug this file exists for');
  assert.match(out, /installer missing|No built installer/);
  assert.match(out, /must not be published/);
});

test('ONLY THE EXE MISSING: metadata alone blocks the release', () => {
  const { status, out } = runGate({ meta: metaFor(synthInstaller()) });
  assert.notStrictEqual(status, 0);
  assert.match(out, /installer missing/);
});

test('ONLY THE METADATA MISSING: an unaccompanied exe blocks the release', () => {
  const { status, out } = runGate({ exe: synthInstaller() });
  assert.notStrictEqual(status, 0);
  assert.match(out, /metadata missing|No built installer/);
});

test('MALFORMED METADATA: unparseable latest.json blocks the release', () => {
  const { status, out } = runGate({ exe: synthInstaller(), rawMeta: '{ this is not json' });
  assert.notStrictEqual(status, 0);
  assert.match(out, /malformed|JSON/i);
});

test('METADATA OF THE WRONG SHAPE: a JSON array is not a candidate', () => {
  const { status } = runGate({ exe: synthInstaller(), rawMeta: '[]' });
  assert.notStrictEqual(status, 0);
});

test('MISSING REQUIRED FIELDS: no sha256 blocks the release', () => {
  const exe = synthInstaller();
  const meta = metaFor(exe);
  delete meta.sha256;
  const { status, out } = runGate({ exe, meta });
  assert.notStrictEqual(status, 0);
  assert.match(out, /sha256/);
});

test('WRONG SIZE: a size that does not describe the exe blocks the release', () => {
  const exe = synthInstaller();
  const { status, out } = runGate({ exe, meta: metaFor(exe, { size: 12345 }) });
  assert.notStrictEqual(status, 0);
  assert.match(out, /size/i);
});

test('WRONG HASH: a sha256 that does not describe the exe blocks the release', () => {
  const exe = synthInstaller();
  const { status, out } = runGate({ exe, meta: metaFor(exe, { sha256: 'f'.repeat(64) }) });
  assert.notStrictEqual(status, 0);
  assert.match(out, /sha256/i);
});

test('CORRUPT IMAGE: bytes that are not a SEA installer block the release', () => {
  const junk = Buffer.alloc(4096, 0x41);  // "AAAA…": not even an MZ header
  const { status, out } = runGate({
    exe: junk,
    meta: { product: 'x', file: 'y', version: '3.5.15', size: junk.length, sha256: sha256(junk), arch: 'x64', signed: false },
  });
  assert.notStrictEqual(status, 0);
  assert.match(out, /SEA image|PE|installer/i);
});

test('STALE EMBEDDED SOURCE: an exe carrying different source blocks the release', () => {
  // The failure the version/size check cannot see: latest.json is perfectly self-consistent, the
  // PE checksum is valid, and the version string matches — but the agent inside is not this tree's.
  const stale = Buffer.concat([REAL_AGENT, Buffer.from('\n// drifted: not the source in this repo\n')]);
  const exe = synthInstaller({ agent: stale });
  const { status, out } = runGate({ exe, meta: metaFor(exe) });
  assert.notStrictEqual(status, 0, 'a self-consistent exe with the wrong source must still be refused');
  assert.match(out, /differs from writehuman-v2\/agent|byte for byte/i);
});

test('STALE BOOTSTRAP: a drifted wh-agent-sea.js also blocks the release', () => {
  const stale = Buffer.concat([REAL_BOOTSTRAP, Buffer.from('\n// drifted bootstrap\n')]);
  const exe = synthInstaller({ bootstrap: stale });
  const { status } = runGate({ exe, meta: metaFor(exe) });
  assert.notStrictEqual(status, 0);
});

test('A COMPLETE, MATCHING CANDIDATE PASSES — the gate is not merely always-red', () => {
  const exe = synthInstaller();
  const { status, out } = runGate({ exe, meta: metaFor(exe) });
  assert.strictEqual(status, 0,
    'a valid candidate must exit 0, or the gate is useless in the other direction:\n' + out);
  assert.match(out, /candidate verified/);
});

// ── The gate must be WIRED IN, not merely available ─────────────────────────────────────────────
//
// A gate nothing calls is decorative. deploy-hostinger.sh ships routes/admin/proxyTools.js, which
// carries EXPECTED_AGENT_VERSION — the version the dashboard advertises and tells field agents to
// update to. These assertions pin the two halves of that pre-flight so neither can be dropped.
test('the deploy script invokes the release gate and aborts on failure', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'deploy-hostinger.sh'), 'utf8');

  assert.match(sh, /npm run --silent test:release-gate/,
    'deploy-hostinger.sh must run the release gate when a candidate dist is present');
  assert.match(sh, /^set -euo pipefail$/m,
    'the gate only aborts the deploy because the script runs under `set -e`');

  // Distribution readiness must be asked ALWAYS, not only when there is no local candidate. The
  // inline curl this used to match was replaced by scripts/verify-agent-distribution.cjs, which
  // checks more than the version string: it also requires the served BYTES to hash to the
  // published sha256. See writehumanAgentDistribution.test.js for that behaviour.
  assert.match(sh, /verify-agent-distribution\.cjs/,
    'the deploy must confirm what is actually downloadable, not only what sits in dist/');
  assert.match(sh, /--version "\$\{AGENT_SRC_VERSION\}"/,
    'the distribution check must be asked about the version this deploy would advertise');

  // The gate must come BEFORE anything is uploaded, or it cannot prevent a bad publish.
  // Compared over EXECUTABLE lines only: this script's header comment describes the upload steps,
  // so searching the raw text finds prose above the gate and the ordering reads backwards.
  const lines = sh.split('\n');
  const code = lines.map((l) => (/^\s*#/.test(l) ? '' : l));
  const firstIdx = (re) => code.findIndex((l) => re.test(l));
  const gateLine = firstIdx(/test:release-gate/);
  // This script uploads with curl over sftp:// (and ssh-keyscan first); match the real commands.
  const uploadLine = firstIdx(/^\s*(curl|lftp|scp|rsync|ssh-keyscan)\b|sftp:\/\//);
  assert.ok(gateLine > -1, 'the release gate must be invoked by the deploy script');
  assert.ok(uploadLine > -1, 'expected an upload command in the deploy script');
  assert.ok(gateLine < uploadLine,
    `the release gate (line ${gateLine + 1}) must run before the first upload command `
    + `(line ${uploadLine + 1}), or it cannot prevent a bad publish`);
});

test('the gate runner propagates a non-zero status rather than swallowing it', () => {
  const runner = fs.readFileSync(path.join(BACKEND, 'scripts', 'release-gate.cjs'), 'utf8');
  assert.match(runner, /WH_RELEASE_GATE:\s*'1'/,
    'the runner must put the gate into require mode, or absent artifacts only skip');
  assert.match(runner, /process\.exit\(/, 'the runner must exit with the child status');
  assert.ok(/r\.status !== 0/.test(runner) && /r\.signal/.test(runner) && /r\.error/.test(runner),
    'a spawn error or a signal must also be treated as failure, not as success');
});

// ── Candidate metadata must not overclaim, and the gate must not trust it ───────────────────────
test('candidate metadata does not present an archive timestamp as a build time', () => {
  const dist = process.env.WH_GATE_DIST_DIR
    || path.join(ROOT, 'writehuman-v2', 'agent', 'dist');
  const metaPath = path.join(dist, 'latest.json');
  if (!fs.existsSync(metaPath)) return;   // nothing staged here; the gate covers absence
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const c = meta.candidate || {};
  if (c.buildTimeEstablished === false) {
    assert.strictEqual(meta.builtAt, null,
      'a ZIP member mtime records when the ARCHIVE was written, not when the binary was built. '
      + 'With no evidence of the real build time, builtAt must be null rather than an archive '
      + 'timestamp dressed up as a build time.');
  }
});

test('the gate decides from bytes, never from candidate self-description', () => {
  // A flag like publiclyAvailable:false is documentation. If the gate consulted it, a mislabelled
  // candidate could talk its way past verification.
  const gate = fs.readFileSync(path.join(BACKEND, 'tests', 'writehumanInstallerEmbeddedSource.test.js'), 'utf8');
  for (const flag of ['publiclyAvailable', 'channel', 'buildTimeEstablished', 'publishedToHostinger',
    'builtInThisSession', 'notVerified', 'safeguardNote']) {
    assert.ok(!gate.includes(flag),
      `the release gate must not branch on candidate.${flag}: verification comes from the exe and `
      + 'the source bytes, not from what the metadata says about itself');
  }
  // The one metadata field it is allowed to require is `signed`, and only to forbid overclaiming.
  assert.match(gate, /meta\.signed/);
});

// ── The runner's own environment ────────────────────────────────────────────────────────────────
//
// node:test sets NODE_TEST_CONTEXT for every file it runs. A nested `node --test` that inherits it
// believes it is a reporting child of an outer run, SKIPS EXECUTION, and exits 0. Measured on
// node v24.14.1 against the previous runner, with no installer and no latest.json:
//
//     clean environment            -> exit 1, no verdict
//     NODE_TEST_CONTEXT=child-v8   -> exit 0, "candidate verified", and no test summary at all
//
// A release cut from any shell that had already run node:test would have been told the candidate
// was verified while nothing ran. Stripping the variable inside the TEST harness (as the harness
// above does for its own spawns) fixed the tests and left the real runner broken, so these cases
// hand the runner a dirty environment deliberately and require it to clean up after itself.
describe('the gate verifies regardless of an inherited test context', () => {
  const scenarios = [
    ['both files missing', () => ({})],
    ['wrong hash', () => { const exe = synthInstaller(); return { exe, meta: metaFor(exe, { sha256: 'f'.repeat(64) }) }; }],
    ['stale embedded source', () => {
      const stale = Buffer.concat([REAL_AGENT, Buffer.from('\n// drifted\n')]);
      const exe = synthInstaller({ agent: stale });
      return { exe, meta: metaFor(exe) };
    }],
  ];

  for (const [name, build] of scenarios) {
    test(`INHERITED CONTEXT: ${name} still blocks the release`, () => {
      const { status, out } = runGate({ ...build(), inheritTestContext: true });
      assert.notStrictEqual(status, 0,
        `with NODE_TEST_CONTEXT inherited, "${name}" must still fail — a skipped suite is not a pass`);
      assert.ok(!/candidate verified/.test(out),
        'the gate must not print a success verdict for a run that did not verify anything');
    });
  }

  test('INHERITED CONTEXT: a valid candidate still passes, and really does run', () => {
    const exe = synthInstaller();
    const { status, out } = runGate({ exe, meta: metaFor(exe), inheritTestContext: true });
    assert.strictEqual(status, 0, `a valid candidate must still verify in a dirty environment:\n${out}`);
    assert.match(out, /candidate verified/);
    // Proof of execution, not merely a zero status: both suites must report their own results.
    assert.match(out, /writehumanAgentVersionDrift\.test\.js: \d+\/\d+ passed/);
    assert.match(out, /writehumanInstallerEmbeddedSource\.test\.js: \d+\/\d+ passed/);
  });

  test('the runner strips the test context and proves each suite executed', () => {
    const runner = fs.readFileSync(path.join(BACKEND, 'scripts', 'release-gate.cjs'), 'utf8');
    assert.match(runner, /delete env\[v\]|delete env\.NODE_TEST_CONTEXT/,
      'the RUNNER must sanitise its own child environment, not rely on its callers');
    assert.match(runner, /NODE_TEST_CONTEXT/);
    // A zero exit cannot distinguish "all passed" from "nothing ran", so the summary is parsed.
    assert.ok(/# tests/.test(runner) && /did not execute/.test(runner),
      'the runner must treat a missing TAP summary as a suite that did not run');
    assert.match(runner, /skipped/,
      'under the gate a skipped artifact assertion must not count as a pass');
  });
});
