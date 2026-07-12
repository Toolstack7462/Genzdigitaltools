'use strict';
/**
 * Regression tests for semantic-version comparison used by the Chrome Extension Update Policy.
 * Runs with Node's built-in runner (no jest needed):  node --test backend/tests/semver.test.js
 *
 * Guards the root cause of the "minVersion cannot be greater than the published version" false
 * error: (1) proper numeric semver comparison (not string/lexicographic), and (2) the effective
 * published version = the NEWER of the on-disk ZIP and the DB release row (maxVersion).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { compareVersions, isOlder, isValidVersion, maxVersion, parse } = require('../utils/semver');

test('compareVersions: lower / equal / greater', () => {
  assert.equal(compareVersions('3.9.10', '3.9.13'), -1, '3.9.10 < 3.9.13');
  assert.equal(compareVersions('3.9.13', '3.9.13'), 0, 'equal');
  assert.equal(compareVersions('3.9.14', '3.9.13'), 1, '3.9.14 > 3.9.13');
});

test('compareVersions: numeric, not lexicographic (patch 10 vs 9, 2 vs 10)', () => {
  assert.equal(compareVersions('3.9.10', '3.9.9'), 1, '10 > 9 numerically (string compare would fail)');
  assert.equal(compareVersions('3.9.2', '3.9.10'), -1, '2 < 10 numerically');
  assert.equal(compareVersions('3.10.0', '3.9.99'), 1, 'minor 10 > 9');
});

test('compareVersions: missing patch / short versions', () => {
  assert.equal(compareVersions('3.9', '3.9.0'), 0, '3.9 == 3.9.0');
  assert.equal(compareVersions('3.9', '3.9.1'), -1, '3.9 (=3.9.0) < 3.9.1');
  assert.equal(compareVersions('4', '3.9.13'), 1, '4 (=4.0.0) > 3.9.13');
  assert.equal(compareVersions('3.9.13', '3.9.13.0'), 0, 'trailing zero segment equal');
});

test('compareVersions: v-prefix is ignored (v3.9.13 == 3.9.13)', () => {
  assert.equal(compareVersions('v3.9.13', '3.9.13'), 0);
  assert.equal(compareVersions('V3.9.10', 'v3.9.13'), -1);
  assert.equal(compareVersions('3.9.10', 'v3.9.13'), -1);
});

test('isValidVersion accepts real versions (incl. v-prefix) and rejects junk', () => {
  for (const v of ['3.9.13', 'v3.9.13', '3.9', '4', '3.9.13-beta.1', '1.2.3.4']) assert.ok(isValidVersion(v), `${v} valid`);
  for (const v of ['', 'abc', '3.x.1', 'latest', null, undefined]) assert.ok(!isValidVersion(v), `${JSON.stringify(v)} invalid`);
});

test('isOlder', () => {
  assert.ok(isOlder('3.9.10', '3.9.13'));
  assert.ok(!isOlder('3.9.13', '3.9.13'));
  assert.ok(!isOlder('3.9.14', '3.9.13'));
  assert.ok(!isOlder(null, '3.9.13') && !isOlder('3.9.13', null));
});

test('maxVersion picks the newer version, null-safe, disk-wins-ties', () => {
  assert.equal(maxVersion('3.9.13', '3.9.1'), '3.9.13', 'disk newer than db');
  assert.equal(maxVersion('3.9.1', '3.9.13'), '3.9.13', 'db newer than disk');
  assert.equal(maxVersion('3.9.13', '3.9.13'), '3.9.13', 'equal → first arg');
  assert.equal(maxVersion('3.9.13', null), '3.9.13');
  assert.equal(maxVersion(null, '3.9.13'), '3.9.13');
  assert.equal(maxVersion(null, null), null);
});

// The exact reported scenario: published ZIP on disk is 3.9.13 but the DB release row is stale
// (e.g. 3.9.1). Saving minVersion 3.9.10 must be ALLOWED (it is lower than the true published
// version). Previously the ceiling used the stale DB version only and wrongly rejected it.
test('BUG REGRESSION: minVersion 3.9.10 allowed when disk=3.9.13 even if DB row is stale 3.9.1', () => {
  const diskVersion = '3.9.13';
  const dbVersion = '3.9.1';
  const published = maxVersion(diskVersion, dbVersion); // effective published version
  assert.equal(published, '3.9.13');

  const allowed = (min) => !(min && published && compareVersions(min, published) > 0);
  assert.ok(allowed('3.9.10'), 'lower than published → allowed');
  assert.ok(allowed('3.9.13'), 'equal to published → allowed');
  assert.ok(allowed('v3.9.13'), 'equal (v-prefix) → allowed');
  assert.ok(!allowed('3.9.14'), 'greater than published → rejected');
  assert.ok(!allowed('4.0.0'), 'far greater → rejected');
});
