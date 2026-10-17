'use strict';
/**
 * RELEASE GATE: the installer must actually CARRY the source this repo ships.
 *
 * WHY THIS TEST EXISTS. The agent suite that travels with a release candidate reports 222 passing,
 * and that number is identical whether or not the 91 MB installer is even present. Inspecting what
 * those tests read explains why:
 *
 *   - tests/pe-checksum.test.js   builds a 513-byte synthetic PE with Buffer.alloc and hand-written
 *                                 MZ/PE headers.
 *   - tests/extraction.test.js    reads the shipped cookie-sync-agent.js, then assembles SYNTHETIC
 *                                 SEA payloads ("module.exports={fixture:true}").
 *
 * Neither ever opens the real executable, so "all tests pass" said nothing about the artifact a
 * field agent downloads. writehumanAgentVersionDrift only checks the version and SIZE recorded in
 * latest.json, never the bytes INSIDE the exe.
 *
 * TWO MODES, AND THE DIFFERENCE IS THE WHOLE POINT.
 *
 *   WH_RELEASE_GATE unset (ordinary PR CI)
 *       dist/ is gitignored, so a fresh clone has no candidate. The absence is reported as an
 *       explicit skip, because there is genuinely nothing to verify.
 *
 *   WH_RELEASE_GATE=1 (npm run test:release-gate, i.e. cutting a release)
 *       a missing, unreadable, corrupt or inconsistent candidate FAILS, with a non-zero exit code.
 *       An earlier version of this file skipped in both modes and therefore exited 0 with no
 *       artifacts at all: it could not block anything, which is the one job a release gate has.
 *
 * The candidate location is overridable with WH_GATE_DIST_DIR so the exit-code behaviour itself can
 * be regression-tested against fixtures (see writehumanReleaseGateExit.test.js) without disturbing
 * a real dist directory.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_DIR = path.join(ROOT, 'writehuman-v2', 'agent');
const DIST = process.env.WH_GATE_DIST_DIR || path.join(AGENT_DIR, 'dist');
const EXE = path.join(DIST, 'WriteHuman-Agent-Setup-x64.exe');
const META = path.join(DIST, 'latest.json');
const REQUIRE_CANDIDATE = process.env.WH_RELEASE_GATE === '1';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Load the candidate, collecting every reason it cannot be verified rather than throwing at import
 * time (a throw there aborts the file and reports a crash instead of a reason).
 */
function loadCandidate() {
  const problems = [];
  if (!fs.existsSync(EXE)) problems.push(`installer missing: ${EXE}`);
  if (!fs.existsSync(META)) problems.push(`metadata missing: ${META}`);
  if (problems.length) return { problems };

  let bytes;
  let meta;
  try { bytes = fs.readFileSync(EXE); } catch (e) { problems.push(`installer unreadable: ${e.message}`); }
  try { meta = JSON.parse(fs.readFileSync(META, 'utf8')); } catch (e) { problems.push(`metadata malformed: ${e.message}`); }
  if (problems.length) return { problems };
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { problems: ['metadata is not a JSON object'] };
  }
  for (const field of ['version', 'size', 'sha256']) {
    if (meta[field] === undefined || meta[field] === null) problems.push(`metadata field missing: ${field}`);
  }
  if (problems.length) return { problems };

  let extracted;
  try {
    const { extract } = require(path.join(AGENT_DIR, 'tools', 'extract-sea.cjs'));
    extracted = extract(bytes);
  } catch (e) {
    problems.push(`installer is not a readable SEA image: ${e.message}`);
  }
  if (problems.length) return { problems };
  return { bytes, meta, extracted };
}

const candidate = loadCandidate();

if (candidate.problems) {
  const detail = candidate.problems.map((p) => `  - ${p}`).join('\n');
  if (REQUIRE_CANDIDATE) {
    test('RELEASE GATE: a verifiable candidate installer is required', () => {
      assert.fail(
        'the release gate cannot verify a candidate installer:\n' + detail + '\n\n'
        + 'A release must not be cut from this tree. Either build the installer\n'
        + '  node writehuman-v2/agent/build-installer.mjs\n'
        + 'or do not publish: every field agent would be offered a download that does not match\n'
        + 'the source this repository ships, which is the 2026-08-26 failure.');
    });
  } else {
    test('release gate skipped — no verifiable candidate in the dist directory', (t) => {
      t.diagnostic('dist/ is gitignored, so a fresh clone has nothing to verify:');
      candidate.problems.forEach((p) => t.diagnostic(`  ${p}`));
      t.diagnostic('Run `npm run test:release-gate` before publishing; there this is a FAILURE.');
      t.skip('no candidate present (WH_RELEASE_GATE is not set)');
    });
  }
} else {
  const { bytes, meta, extracted } = candidate;

  test('latest.json describes the exe sitting beside it', () => {
    assert.strictEqual(meta.size, bytes.length,
      'latest.json size does not match the exe — the pair is out of sync, so the published sha256 '
      + 'would not match the served file');
    assert.strictEqual(meta.sha256, sha256(bytes),
      'latest.json sha256 does not match the exe bytes');
  });

  test('the exe EMBEDS this repository’s agent source, byte for byte', () => {
    for (const name of ['cookie-sync-agent.js', 'wh-agent-sea.js']) {
      const onDisk = fs.readFileSync(path.join(AGENT_DIR, name));
      const inExe = extracted.files[name];
      assert.ok(inExe, `the installer carries no ${name} asset`);
      assert.strictEqual(sha256(inExe), sha256(onDisk),
        `${name} inside the installer differs from writehuman-v2/agent/${name}.\n`
        + `  in exe: ${sha256(inExe)}\n  on disk: ${sha256(onDisk)}\n`
        + 'Rebuild the installer from the current source, or do not ship this exe: every field '
        + 'agent would run code that is not in this repository.');
    }
  });

  test('the advertised version is the version the embedded source declares', () => {
    const embedded = extracted.files['cookie-sync-agent.js'].toString('utf8');
    const m = embedded.match(/AGENT_VERSION\s*=\s*'([^']+)'/);
    assert.ok(m, 'no AGENT_VERSION in the embedded agent source');
    assert.strictEqual(meta.version, m[1],
      'latest.json advertises a different version than the exe actually contains');
  });

  test('the PE checksum in the header matches the bytes', () => {
    const { inspect } = require(path.join(AGENT_DIR, 'tools', 'pe-checksum.cjs'));
    const r = inspect(bytes);
    assert.strictEqual(r.matches, true,
      'the PE header checksum does not match the file — the binary was altered after it was built');
  });

  test('an unsigned candidate says so, rather than implying it is signed', () => {
    assert.strictEqual(meta.signed, false,
      'this project has no Authenticode certificate; latest.json must not claim otherwise');
  });
}
