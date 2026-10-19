'use strict';
/**
 * AGENT VERSION BADGE HONESTY — "update available" must mean OLDER, not merely DIFFERENT.
 *
 * WHY THIS TEST EXISTS. `/:tool/agent-state` computed its update flag as a raw string inequality:
 *
 *     const agentOutdated = reportedVersion ? (reportedVersion !== EXPECTED_AGENT_VERSION) : null;
 *
 * and AdminWriteHuman.js renders that flag as
 *
 *     <Badge tone="warn">update available → {state.expectedAgentVersion}</Badge>
 *
 * So ANY version that is not character-identical to the expected one is reported as needing an
 * update — including an agent running something NEWER. A machine on 3.5.13 against an expected
 * 3.5.2 is told "update available → 3.5.2", i.e. to DOWNGRADE to an older build. That is the same
 * class of untruthful operator signal that writehumanAgentVersionDrift.test.js exists to prevent:
 * the dashboard must not advertise an update that is not an update.
 *
 * It is also a lexicographic trap. '3.5.13' and '3.5.2' differ in a way that a naive string
 * comparison orders BACKWARDS (because '1' < '2'), which is exactly why this repo already carries
 * semver comparators and documents "never string compare" in both utils/semver.js and
 * frontend/src/lib/semver.js.
 *
 * THE RULE: the flag is TRUE only when the reported version is strictly older than expected.
 * Equal → up to date. Newer → not an update (never a downgrade prompt).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PROXY_TOOLS = path.join(ROOT, 'backend', 'routes', 'admin', 'proxyTools.js');
const { atLeast } = require('../utils/proxy/agentCommands');

// The comparator the route must use. Sanity-check it orders multi-digit segments NUMERICALLY,
// since that is the precise case the string compare got wrong.
test('the agent comparator orders multi-digit patch segments numerically, not lexicographically', () => {
  assert.strictEqual(atLeast('3.5.13', '3.5.2'), true, '3.5.13 is NEWER than 3.5.2');
  assert.strictEqual(atLeast('3.5.2', '3.5.13'), false, '3.5.2 is OLDER than 3.5.13');
  assert.strictEqual(atLeast('3.5.2', '3.5.2'), true, 'equal versions satisfy the floor');
});

/**
 * The update flag, expressed exactly as the route computes it. Kept as a local mirror because the
 * route itself needs a database and an authenticated request to reach; the STATIC assertion below
 * pins the route to this same expression so the mirror cannot drift away from it.
 */
const updateFlag = (reported, expected) => (reported ? !atLeast(reported, expected) : null);

test('an agent running a NEWER build is not told to downgrade', () => {
  assert.strictEqual(
    updateFlag('3.5.13', '3.5.2'), false,
    'a 3.5.13 agent against an expected 3.5.2 must NOT be flagged "update available → 3.5.2"');
});

test('an agent running an OLDER build is still flagged for update', () => {
  assert.strictEqual(updateFlag('3.5.0', '3.5.2'), true);
  assert.strictEqual(updateFlag('3.4.0', '3.5.2'), true);
  assert.strictEqual(updateFlag('2.5.2', '3.5.2'), true);
});

test('an agent running the expected build reports up to date', () => {
  assert.strictEqual(updateFlag('3.5.2', '3.5.2'), false);
});

test('an agent that has not reported a version yields null, not a false alarm', () => {
  assert.strictEqual(updateFlag(null, '3.5.2'), null);
});

/**
 * The static guard. This is what actually fails on the unfixed route: it pins the computation to a
 * semver comparison and forbids the raw string inequality that produced the downgrade prompt.
 */
test('the route computes agentOutdated with a semver comparison, never string inequality', () => {
  const src = fs.readFileSync(PROXY_TOOLS, 'utf8');
  // The whole STATEMENT, not one line: the validated form spans three lines, and a single-line
  // read made this assertion fail on a correct fix — which would have pushed someone to cram it
  // back onto one line to satisfy the test.
  const at = src.indexOf('const agentOutdated');
  assert.ok(at > -1, 'agentOutdated is no longer computed in proxyTools.js — update this test');
  const line = src.slice(at, src.indexOf(';', src.indexOf('atLeast(', at)) + 1).replace(/\s+/g, ' ');
  assert.ok(
    !/reportedVersion\s*!==\s*EXPECTED_AGENT_VERSION/.test(line),
    'agentOutdated must not be a raw string inequality: an agent on a NEWER build is then told '
    + '"update available →" an OLDER version. Compare with agentCommands.atLeast instead.\n'
    + `  found: ${line.trim()}`);
  assert.match(
    line, /atLeast\(/,
    'agentOutdated must be derived from the agentCommands.atLeast semver comparator (already '
    + 'required by this route), so "update available" means strictly older.');
});

// ── THE 2026-10-18 SCREENSHOT, and the three facts it conflated ───────────────────────────────
//
// "Installed Agent 3.5.15, but update available → 3.5.2". Three different things were being read
// as one:
//
//   installed            what the reporting machine runs                    (agent telemetry)
//   compatibility floor  EXPECTED_AGENT_VERSION, a policy minimum           (server constant)
//   published installer  what the public download route actually serves     (its own metadata)
//
// The flag below is ONLY about the floor. What is downloadable is a separate question answered by
// GET /downloads/writehuman-agent/windows/latest.json, and the dashboard must not present the
// floor as a downloadable version. These cases are the ones named in the incident report.
// Mirrors the route exactly: validate BOTH sides, then compare. Read out of the route source so
// the two cannot drift — a copy of the rule here would pass while production still guessed.
const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin', 'proxyTools.js'), 'utf8');
const VERSION_RE = (() => {
  const m = ROUTE_SRC.match(/^const VERSION_RE = (\/.*\/);$/m);
  assert.ok(m, 'the route must define VERSION_RE');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
})();
const isVersionString = (v) => typeof v === 'string' && VERSION_RE.test(v);
const outdated = (installed, floor) =>
  (isVersionString(installed) && isVersionString(floor)) ? !atLeast(installed, floor) : null;

test('INCIDENT CASE: 3.5.15 installed against a 3.5.2 floor is NOT an update — never a downgrade', () => {
  assert.strictEqual(outdated('3.5.15', '3.5.2'), false);
});

test('INCIDENT CASE: 3.5.15 installed and 3.5.15 published is no update', () => {
  assert.strictEqual(outdated('3.5.15', '3.5.15'), false);
});

test('INCIDENT CASE: 3.5.2 installed against a verified 3.5.15 is a real update', () => {
  assert.strictEqual(outdated('3.5.2', '3.5.15'), true);
});

test('INCIDENT CASE: a missing or malformed version on EITHER side is unknown', () => {
  // atLeast() parses with parseInt and treats anything unparseable as 0, so without validation the
  // route answered confidently about garbage — and in BOTH directions:
  //   'nonsense' / '3.5.15'  ->  0.0.0 < 3.5.15  ->  outdated TRUE   (a bogus update prompt)
  //   '3.5.15'   / 'nonsense' -> 3.5.15 > 0.0.0  ->  outdated FALSE  (a bogus all-clear)
  // Neither was null. Both must be.
  assert.strictEqual(outdated('nonsense', '3.5.15'), null, 'a malformed INSTALLED version is unknown');
  assert.strictEqual(outdated('3.5.15', 'nonsense'), null, 'a malformed FLOOR is unknown');
  // And the raw comparator still shows why the validation is needed, so this stays honest about
  // what was fixed: the guard, not atLeast itself.
  assert.strictEqual(atLeast('nonsense', '3.5.15'), false);
  assert.strictEqual(atLeast('3.5.15', 'nonsense'), true);

  for (const v of [null, undefined, '', '3.5', '3', 'v3.5.15', '3.5.15.1', ' 3.5.15', '3.5.x', 0, 3.5, {}, []]) {
    assert.strictEqual(outdated(v, '3.5.15'), null, `installed ${JSON.stringify(v)} must be unknown`);
    assert.strictEqual(outdated('3.5.15', v), null, `floor ${JSON.stringify(v)} must be unknown`);
  }
  // A legitimate pre-release suffix is still a version.
  assert.strictEqual(outdated('3.5.15-retry-rc1', '3.5.2'), false);
  assert.strictEqual(outdated('3.5.2', '3.5.15-retry-rc1'), true);
});

test('the route itself validates before comparing — not just this test file', () => {
  assert.match(ROUTE_SRC, /const agentOutdated = \(isVersionString\(reportedVersion\) && isVersionString\(EXPECTED_AGENT_VERSION\)\)/,
    'agentOutdated must be guarded by isVersionString on BOTH sides');
  assert.doesNotMatch(ROUTE_SRC, /const agentOutdated = reportedVersion \? !agentCommands\.atLeast/,
    'the unvalidated form must not come back');
});

test('a satisfied compatibility minimum is NOT a claim that the newest build is installed', () => {
  // 3.5.15 installed against a 3.5.2 floor means "allowed to run", nothing more. Whether something
  // newer exists is answered by the PUBLISHED installer metadata, which this flag never reads.
  assert.strictEqual(outdated('3.5.15', '3.5.2'), false);
  assert.doesNotMatch(ROUTE_SRC.slice(ROUTE_SRC.indexOf('const agentOutdated')).slice(0, 400),
    /latest|published|downloadUrl/i, 'the floor comparison must not consult or imply the published build');
});

test('the compatibility floor is preserved: the command router keeps its own minimum', () => {
  // Lowering or conflating the floor to make a badge quiet would silently let an agent too old for
  // the command protocol be addressed. MIN_AGENT_VERSION stays the router's own gate.
  const agentCommands = require('../utils/proxy/agentCommands');
  assert.match(String(agentCommands.MIN_AGENT_VERSION), /^\d+\.\d+\.\d+$/);
  assert.strictEqual(agentCommands.atLeast('3.5.15', agentCommands.MIN_AGENT_VERSION), true);
});
