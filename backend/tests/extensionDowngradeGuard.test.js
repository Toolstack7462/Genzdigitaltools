'use strict';
/**
 * The extension upload route must refuse an accidental version downgrade.
 *
 * WHY THIS EXISTS. Publishing overwrites the served ZIP in place, so uploading an older build
 * silently replaces a newer production release and every client is then offered the stale
 * extension. That is exactly what happened on 2026-08-22: v3.9.20 was being served while v3.9.25
 * was the real latest, and nothing in the upload path noticed.
 *
 * The guard compares against the EFFECTIVE published version — the newer of the on-disk ZIP and
 * the DB release row — which is the same value /release shows the admin, so a block can never
 * contradict what the panel displays. Deliberate rollback stays possible via ?allowDowngrade=1.
 *
 * These assertions pin the DECISION LOGIC (semver comparison + effective-latest + the override),
 * not the HTTP plumbing, so they stay meaningful without standing up Express and a database.
 */
const test = require('node:test');
const assert = require('node:assert');

const { isOlder, maxVersion, isValidVersion } = require('../utils/semver');

// Mirrors the route: effectiveLatest = newer of (DB row, on-disk ZIP).
const effectiveLatest = (dbVersion, diskVersion) => maxVersion(diskVersion, dbVersion);

// Mirrors the guard in routes/admin/extension.js POST /upload.
function shouldBlock(uploadedVersion, dbVersion, diskVersion, allowDowngrade = false) {
  const publishedNow = effectiveLatest(dbVersion, diskVersion);
  const downgrade = !!publishedNow && isOlder(uploadedVersion, publishedNow);
  return downgrade && !allowDowngrade;
}

test('the exact incident is blocked: 3.9.20 uploaded while 3.9.25 is published', () => {
  assert.strictEqual(shouldBlock('3.9.20', '3.9.25', '3.9.25'), true);
});

test('a stale DB row does not let a downgrade through — the on-disk ZIP still counts', () => {
  // DB says 3.9.20 (never updated by the static deploy) but disk already serves 3.9.25.
  assert.strictEqual(shouldBlock('3.9.20', '3.9.20', '3.9.25'), true);
});

test('a newer upload is always allowed', () => {
  assert.strictEqual(shouldBlock('3.9.26', '3.9.25', '3.9.25'), false);
  assert.strictEqual(shouldBlock('3.10.0', '3.9.25', '3.9.25'), false);
});

test('re-uploading the SAME version is allowed (a rebuild is not a downgrade)', () => {
  assert.strictEqual(shouldBlock('3.9.25', '3.9.25', '3.9.25'), false);
});

test('a deliberate rollback is possible, but only when explicitly requested', () => {
  assert.strictEqual(shouldBlock('3.9.20', '3.9.25', '3.9.25', true), false);
});

test('the very first upload is not blocked when nothing is published yet', () => {
  assert.strictEqual(shouldBlock('3.9.25', null, null), false);
});

test('semver compares numerically, not as strings', () => {
  // '3.9.9' > '3.9.10' under a string compare — the classic way this guard gets it wrong.
  assert.strictEqual(isOlder('3.9.9', '3.9.10'), true);
  assert.strictEqual(shouldBlock('3.9.9', '3.9.10', '3.9.10'), true);
});

test('the versions involved in the incident are valid semver', () => {
  for (const v of ['3.9.20', '3.9.25']) assert.ok(isValidVersion(v), `${v} should be valid`);
});
