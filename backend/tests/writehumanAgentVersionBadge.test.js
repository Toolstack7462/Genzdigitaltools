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
  const line = src.split('\n').find(l => l.includes('const agentOutdated'));
  assert.ok(line, 'agentOutdated is no longer computed in proxyTools.js — update this test');
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
