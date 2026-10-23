'use strict';
/**
 * THE GATE THAT WAS MISSING: actually RUN the built installer.
 *
 * 3.5.16 was published having passed the PE-checksum check, the embedded-asset extraction check and
 * the whole artifact gate — and it could not start. `wh-agent-sea.js` pinned
 * `selfAgentVersion() !== '3.5.15'`, so the bootstrap rejected its own 3.5.16 payload with
 * "Invalid embedded Agent package." before doing anything at all, `--package-info` included.
 *
 * Every check that release had was STATIC: it inspected the bytes. None of them executed them. A
 * binary that refuses to start is indistinguishable, under static inspection, from a good one. So
 * this test spawns the real exe and reads what it says about itself.
 *
 * SAFETY — this must never touch a real installation:
 *   - only `--package-info` and `--self-test` are used; both return from main() before any install,
 *     service, Chrome or network path;
 *   - WHV2_INSTALL_DIR is pointed at a throwaway directory anyway, so even a regression that fell
 *     through to the installer could not write into a real one;
 *   - the throwaway directory is asserted to be still empty afterwards, which is what proves the
 *     commands are read-only rather than merely documented as such.
 *
 * COVERAGE RULES:
 *   - with WH_RELEASE_GATE=1 (the pre-publication gate) a missing exe or a non-Windows host is a
 *     FAILURE: publication must not be possible without this acceptance;
 *   - otherwise the suite skips cleanly, so ubuntu CI and dev machines are unaffected.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const AGENT_DIR = path.join(__dirname, '..', '..', 'writehuman-v2', 'agent');
const EXE = path.join(AGENT_DIR, 'dist', 'WriteHuman-Agent-Setup-x64.exe');
const BOOTSTRAP = path.join(AGENT_DIR, 'wh-agent-sea.js');
const ASSET = path.join(AGENT_DIR, 'cookie-sync-agent.js');

const RELEASE_GATE = /^(1|true|yes)$/i.test(String(process.env.WH_RELEASE_GATE || ''));
const haveExe = fs.existsSync(EXE);
const onWindows = process.platform === 'win32';

// The expected identity comes from the SOURCE, never from a constant in this test — a second
// hardcoded version here would rot exactly like the one that caused the defect.
const assetSource = fs.existsSync(ASSET) ? fs.readFileSync(ASSET, 'utf8') : '';
const expectVersion = (assetSource.match(/AGENT_VERSION\s*=\s*'([^']+)'/) || [])[1] || null;
const expectBuildId = (assetSource.match(/AGENT_BUILD_ID\s*=\s*'([^']+)'/) || [])[1] || null;
const expectSourceSha = assetSource ? crypto.createHash('sha256').update(assetSource).digest('hex') : null;

function runExe(arg) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-exe-acceptance-'));
  try {
    const r = spawnSync(EXE, [arg], {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
      env: { ...process.env, WHV2_INSTALL_DIR: sandbox, WHV2_SILENT: '1' },
    });
    const leftovers = fs.readdirSync(sandbox);
    return { ...r, leftovers, sandbox };
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }
}

test('the release gate itself requires this acceptance to be runnable', () => {
  if (!RELEASE_GATE) return; // only enforced when publishing
  assert.ok(haveExe, `WH_RELEASE_GATE=1 but no built installer at ${EXE} — build before publishing`);
  assert.ok(onWindows, 'WH_RELEASE_GATE=1 but this host is not Windows — the executable acceptance cannot run, so publication must not proceed');
});

test('the bootstrap pins no hardcoded expected agent version (the 3.5.16 defect)', () => {
  const src = fs.readFileSync(BOOTSTRAP, 'utf8');
  // Strip comments so the explanatory note about the old literal does not trip this.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
  const pinned = code.match(/selfAgentVersion\(\)\s*!==\s*'[^']+'/g) || [];
  assert.deepEqual(pinned, [], 'validatePackage() compares the embedded version against a literal again');
  assert.equal((code.match(/\bBUILD_ID\s*=\s*'/g) || []).length, 0,
    'a hardcoded BUILD_ID constant is back; build identity must derive from the embedded asset');
  assert.match(code, /function selfBuildId\s*\(/, 'selfBuildId() must derive the build id from the asset');
});

test('validatePackage still refuses a package whose version and build id disagree', () => {
  // The replacement check must be STRONGER than the literal it replaced, not merely different.
  const src = fs.readFileSync(BOOTSTRAP, 'utf8');
  assert.match(src, /\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\//, 'a strict semver shape check is expected');
  assert.match(src, /buildId\.startsWith\(version \+ '-'\)/,
    'the build id must be required to belong to the stated version');
  assert.match(src, /new \(require\('vm'\)\.Script\)\(source/, 'the source must still be parsed');
});

test('upgrade semantics: 3.5.15 -> 3.5.16 is allowed, a downgrade is refused, config is required', () => {
  // Read from the real bootstrap rather than re-implemented here. Executing a true install would
  // write HKCU registry keys and a service on this machine, so the install path itself is verified
  // on the target RDP, not in this suite — see the release report's explicit limitation.
  const src = fs.readFileSync(BOOTSTRAP, 'utf8');
  const fn = src.slice(src.indexOf('function validateUpgrade'));
  assert.match(fn, /^function validateUpgrade\(\)\s*\{\s*\n\s*validatePackage\(\);/,
    'validateUpgrade must run the package check FIRST, so a bad package never reaches an install');
  assert.match(fn, /Existing Agent configuration is missing\. No running Agent was changed\./,
    'a missing configuration must abort without touching the running Agent');
  assert.match(fn, /compareVersion\(version,\s*selfAgentVersion\(\)\)\s*>\s*0/,
    'the downgrade guard must compare the INSTALLED version against this package');
  assert.match(fn, /Refusing to downgrade a newer Agent\./);
  // compareVersion's own contract: strict semver, numeric per-component ordering.
  const cmp = src.slice(src.indexOf('function compareVersion'));
  assert.match(cmp, /\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\//, 'compareVersion must reject non-semver metadata');
  assert.match(cmp, /Invalid Agent version metadata\./);
  // And the backup happens before anything is stopped.
  assert.match(src, /\/\/ Back up before stopping anything/);
});

test('--rollback-check: another read-only entry point also starts', { skip: !haveExe || !onWindows ? 'needs a built installer on Windows' : false }, () => {
  const r = runExe('--rollback-check');
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${String(r.stderr || '').slice(0, 300)}`);
  assert.doesNotMatch(String(r.stderr || ''), /Invalid embedded Agent package/);
  assert.deepEqual(r.leftovers, [], '--rollback-check wrote into the install directory');
});

test('--package-info: the built exe STARTS and reports its own identity', { skip: !haveExe || !onWindows ? 'needs a built installer on Windows' : false }, () => {
  const r = runExe('--package-info');
  assert.equal(r.error, undefined, `spawn failed: ${r.error && r.error.message}`);
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${String(r.stderr || '').slice(0, 400)}`);
  assert.doesNotMatch(String(r.stderr || ''), /Invalid embedded Agent package/,
    'the bootstrap rejected its own payload — this is the 3.5.16 defect');

  let info;
  assert.doesNotThrow(() => { info = JSON.parse(String(r.stdout || '').trim()); },
    `--package-info did not emit JSON: ${String(r.stdout || '').slice(0, 200)}`);

  assert.equal(info.version, expectVersion, 'reported version must equal the embedded asset version');
  assert.equal(info.buildId, expectBuildId, 'reported build id must equal the embedded asset build id');
  assert.equal(info.sourceSha256, expectSourceSha, 'reported source hash must equal the asset on disk');
  assert.equal(info.packaging, 'windows-node-sea', 'the artifact must be the packaged SEA, not a source-only run');
  assert.equal(info.platform, 'win32');
  assert.equal(info.arch, 'x64');
  // Internal consistency: the identity the exe states about itself must agree with itself.
  assert.ok(String(info.buildId).startsWith(String(info.version) + '-'),
    `build id ${info.buildId} does not belong to version ${info.version}`);
  assert.notEqual(info.version, '3.5.15', 'the exe still reports the superseded 3.5.15');
  // Read-only: nothing was written into the sandboxed install dir.
  assert.deepEqual(r.leftovers, [], 'the command wrote into the install directory — it is not read-only');
});

test('--self-test: the same acceptance through the documented self-test flag', { skip: !haveExe || !onWindows ? 'needs a built installer on Windows' : false }, () => {
  const r = runExe('--self-test');
  assert.equal(r.status, 0, `exit ${r.status}; stderr: ${String(r.stderr || '').slice(0, 400)}`);
  const info = JSON.parse(String(r.stdout || '').trim());
  assert.equal(info.version, expectVersion);
  assert.equal(info.buildId, expectBuildId);
  assert.deepEqual(r.leftovers, [], '--self-test wrote into the install directory');
});

test('the published metadata, if present, describes THIS executable', { skip: !haveExe ? 'needs a built installer' : false }, () => {
  const metaPath = path.join(AGENT_DIR, 'dist', 'latest.json');
  if (!fs.existsSync(metaPath)) return;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const bytes = fs.readFileSync(EXE);
  assert.equal(meta.size, bytes.length, 'metadata size does not describe the built exe');
  assert.equal(meta.sha256, crypto.createHash('sha256').update(bytes).digest('hex'),
    'metadata sha256 does not describe the built exe');
  assert.equal(meta.version, expectVersion, 'metadata version disagrees with the embedded asset');
  assert.equal(meta.buildId, expectBuildId, 'metadata build id disagrees with the embedded asset');
});
