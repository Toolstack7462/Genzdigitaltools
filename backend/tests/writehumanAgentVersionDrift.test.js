'use strict';
/**
 * AGENT VERSION DRIFT — the artifact that ships must match the version the server demands.
 *
 * WHY THIS TEST EXISTS. On 2026-08-26 the agent source was bumped 3.3.0 -> 3.4.0 and the backend's
 * `MIN_AGENT_VERSION` / `EXPECTED_AGENT_VERSION` were bumped with it — but the INSTALLER was never
 * rebuilt or republished. The agent is a Node SEA exe with cookie-sync-agent.js embedded as a
 * build-time asset, so editing the source changes nothing for any installed agent and nothing for
 * the download. The result in production:
 *
 *   - every field agent still ran 3.3.0, and the download still served 3.3.0;
 *   - `validateTarget(..., requireCommandSupport)` refused every one of them
 *     (COMMAND_VERSION_UNSUPPORTED), so Open Chrome / Re-sync / Rotate token all failed;
 *   - the token-rotation nudge and the stand-down-on-revoke behaviour — the two agent-side halves
 *     of the fix — were inert, while the dashboard truthfully reported "update available -> 3.4.0"
 *     with nothing to update to.
 *
 * All 538 other tests passed throughout, because they test CODE and this is an ARTIFACT problem.
 * This repo already guards the same class of drift for the frontend bundle
 * (frontendBuildFreshness) and the extension zip; the agent needed the same.
 *
 * The rule: source version == what the backend demands == what is published for download.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_SRC = path.join(ROOT, 'writehuman-v2', 'agent', 'cookie-sync-agent.js');
const DIST_META = path.join(ROOT, 'writehuman-v2', 'agent', 'dist', 'latest.json');
const DIST_EXE = path.join(ROOT, 'writehuman-v2', 'agent', 'dist', 'WriteHuman-Agent-Setup-x64.exe');
const PROXY_TOOLS = path.join(ROOT, 'backend', 'routes', 'admin', 'proxyTools.js');

function sourceVersion() {
  const m = fs.readFileSync(AGENT_SRC, 'utf8').match(/AGENT_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, 'AGENT_VERSION not found in cookie-sync-agent.js');
  return m[1];
}
function expectedAgentVersion() {
  // Read the DEFAULT out of the route rather than requiring the module (which needs a DB + env).
  const m = fs.readFileSync(PROXY_TOOLS, 'utf8')
    .match(/EXPECTED_AGENT_VERSION\s*=\s*process\.env\.PROXY_EXPECTED_AGENT_VERSION\s*\|\|\s*'([^']+)'/);
  assert.ok(m, 'EXPECTED_AGENT_VERSION default not found in proxyTools.js');
  return m[1];
}

test('the agent source version is a real semver', () => {
  assert.match(sourceVersion(), /^\d+\.\d+\.\d+$/);
});

test('the version the COMMAND ROUTER demands matches the agent source', () => {
  const { MIN_AGENT_VERSION } = require('../utils/proxy/agentCommands');
  assert.strictEqual(
    MIN_AGENT_VERSION, sourceVersion(),
    'agentCommands.MIN_AGENT_VERSION must equal the agent source AGENT_VERSION — otherwise the '
    + 'server refuses commands to the very agent it ships (COMMAND_VERSION_UNSUPPORTED), or accepts '
    + 'commands from an agent too old to validate their addressing.');
});

test('the version the DASHBOARD advertises matches the agent source', () => {
  assert.strictEqual(
    expectedAgentVersion(), sourceVersion(),
    'proxyTools EXPECTED_AGENT_VERSION must equal the agent source AGENT_VERSION — otherwise the '
    + 'admin page shows "update available" pointing at a version that does not exist.');
});

/**
 * The one that actually catches the 2026-08-26 mistake. `dist/` is gitignored (a 90 MB binary does
 * not belong in git), so this is a LOCAL pre-deploy gate: deploys are cut from a working copy, and
 * that is exactly where the stale artifact sits. If you have not built, you have not shipped.
 */
test('the PUBLISHED installer is built from the current agent source', () => {
  const v = sourceVersion();
  assert.ok(fs.existsSync(DIST_META),
    `No built installer at ${DIST_META}.\n`
    + `Run:  node writehuman-v2/agent/build-installer.mjs\n`
    + `The backend now demands agent ${v}; without a matching build, every field agent is refused `
    + `commands and the download serves the old version.`);
  const meta = JSON.parse(fs.readFileSync(DIST_META, 'utf8'));
  assert.strictEqual(
    meta.version, v,
    `Built installer is ${meta.version} but the agent source is ${v}.\n`
    + `Rebuild:  node writehuman-v2/agent/build-installer.mjs\n`
    + `then publish dist/ to the server (WH_AGENT_DIST_DIR, default ~/writehuman-agent) AND the `
    + `worker-HOME copy. Bumping the source without rebuilding leaves every agent in the field `
    + `unable to receive commands.`);
  assert.ok(fs.existsSync(DIST_EXE), 'latest.json exists but the .exe beside it does not');
  const size = fs.statSync(DIST_EXE).size;
  assert.strictEqual(size, meta.size,
    `dist exe is ${size} bytes but latest.json claims ${meta.size} — the pair is out of sync, so `
    + `the published sha256 would not match the served file.`);
});

test('the installer build script derives its version from the agent source, not a literal', () => {
  // Guards the single-source-of-truth property this whole test relies on.
  const s = fs.readFileSync(path.join(ROOT, 'writehuman-v2', 'agent', 'build-installer.mjs'), 'utf8');
  assert.match(s, /AGENT_VERSION\s*=\s*\(fs\.readFileSync\([^)]*cookie-sync-agent\.js/,
    'build-installer.mjs must read the version from cookie-sync-agent.js');
});
