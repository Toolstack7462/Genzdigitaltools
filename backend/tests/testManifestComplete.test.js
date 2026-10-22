'use strict';

/**
 * EVERY TEST FILE MUST ACTUALLY RUN.
 *
 * `npm test` is an EXPLICIT list of files, not `node --test tests/`. That is deliberate (order and
 * isolation matter for a few suites), but it has the same failure mode as the two deploy manifests
 * in this repo: a file that is added and never listed simply never runs, and nothing says so.
 *
 * It had already happened. On 2026-10-21, CRM Release 1 shipped with
 *
 *   tests/businessCrmAuditResponse.test.js        the audit allow-list fix's own test
 *   tests/businessCrmReleaseCompatibility.test.js the contact-create key compatibility matrix
 *   tests/crmDeployPromoteGuard.test.js           the deploy-helper guard
 *
 * none of them in the list - so the PR's green "Backend tests" check had never executed a single
 * one of them. Four older files (deviceProfileResolve, proxySleepTransform,
 * writehumanClientRouteHealth, writehumanHostGuardEscape) had drifted out the same way.
 *
 * This test is cheap and it closes that gap permanently: add a file, and CI tells you to list it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const PACKAGE_JSON = path.join(__dirname, '..', 'package.json');

test('every tests/*.test.js file appears in the npm test command', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const script = pkg.scripts.test;
  assert.ok(script && script.startsWith('node --test '), 'npm test must still be an explicit node --test list');

  const listed = new Set(script.match(/tests\/[A-Za-z0-9_.-]+\.test\.js/g) || []);
  const onDisk = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js')).map((f) => `tests/${f}`);

  const missing = onDisk.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [],
    `these test files exist but never run - add them to "scripts.test" in backend/package.json:\n  ${missing.join('\n  ')}`);
});

test('the npm test command does not list files that no longer exist', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const listed = pkg.scripts.test.match(/tests\/[A-Za-z0-9_.-]+\.test\.js/g) || [];
  const stale = listed.filter((rel) => !fs.existsSync(path.join(__dirname, '..', rel)));
  assert.deepEqual(stale, [], `listed but absent - node --test would fail on these:\n  ${stale.join('\n  ')}`);
});

test('no test file is listed twice', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const listed = pkg.scripts.test.match(/tests\/[A-Za-z0-9_.-]+\.test\.js/g) || [];
  const seen = new Set();
  const dupes = listed.filter((f) => (seen.has(f) ? true : (seen.add(f), false)));
  assert.deepEqual([...new Set(dupes)], [], 'a duplicated entry runs a suite twice and hides timing problems');
});

test('test:ci runs the same list, so CI and a laptop cannot diverge', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const ci = pkg.scripts['test:ci'];
  assert.ok(ci, 'test:ci must exist - the CI workflow invokes it');
  // either it delegates to `npm test`, or it is the identical list; a second hand-maintained copy
  // is how a file ends up running locally and not in CI
  if (!/^npm run test$/.test(ci.trim())) {
    assert.equal(ci.replace(/\s+/g, ' ').trim(), pkg.scripts.test.replace(/\s+/g, ' ').trim(),
      'test:ci must delegate to npm test, or be byte-identical to it');
  }
});
