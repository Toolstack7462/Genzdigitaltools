'use strict';
/**
 * RELEASE GATE: the installer must actually CARRY the source this repo ships.
 *
 * WHY THIS TEST EXISTS. The agent suite that travels with a release candidate reports a healthy
 * number — 222 passing — and that number is identical whether or not the 91 MB installer is even
 * present. Inspecting what those tests read explains why:
 *
 *   - tests/pe-checksum.test.js   builds a 513-byte synthetic PE with Buffer.alloc and hand-written
 *                                 MZ/PE headers.
 *   - tests/extraction.test.js    reads the shipped cookie-sync-agent.js, then assembles SYNTHETIC
 *                                 SEA payloads ("module.exports={fixture:true}").
 *
 * Neither ever opens the real executable. So "all tests pass" said nothing whatsoever about the
 * artifact a field agent would download — the one thing a release actually ships. That is the same
 * shape of hole as the 2026-08-26 drift (source bumped, installer never rebuilt), and
 * writehumanAgentVersionDrift only checks the version and SIZE recorded in latest.json, never the
 * bytes INSIDE the exe.
 *
 * This gate opens the real PE and proves, byte for byte, that the SEA assets it carries are the
 * files in this repository. A rebuilt installer with stale embedded source fails here, as does a
 * source edit published against an old exe.
 *
 * IT IS A RELEASE GATE, NOT A PR CHECK. dist/ is gitignored (a ~90 MB binary does not belong in
 * git), so on a fresh clone there is nothing to verify and the gate reports that it cannot run
 * rather than inventing a pass. Run it from a working copy that holds the candidate dist, which is
 * exactly where a deploy is cut from. The four source-only drift assertions stay in PR CI.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_DIR = path.join(ROOT, 'writehuman-v2', 'agent');
const DIST = path.join(AGENT_DIR, 'dist');
const EXE = path.join(DIST, 'WriteHuman-Agent-Setup-x64.exe');
const META = path.join(DIST, 'latest.json');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const present = fs.existsSync(EXE) && fs.existsSync(META);

// A missing artifact is a PREREQUISITE, never a silent pass. Stated once, loudly.
if (!present) {
  test('RELEASE GATE SKIPPED — no candidate installer in writehuman-v2/agent/dist/', (t) => {
    t.diagnostic('dist/ is gitignored, so a fresh clone has no artifact to verify.');
    t.diagnostic('Before cutting a release, place the candidate exe + latest.json in dist/ and re-run.');
    t.skip('no artifact present');
  });
} else {
  const { extract } = require(path.join(AGENT_DIR, 'tools', 'extract-sea.cjs'));
  const bytes = fs.readFileSync(EXE);
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  const extracted = extract(bytes);   // static parse; never executes the image

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
