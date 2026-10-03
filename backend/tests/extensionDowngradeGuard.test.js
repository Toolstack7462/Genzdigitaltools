'use strict';
/**
 * The extension upload route must refuse an accidental version downgrade.
 *
 * WHY THIS EXISTS. Publishing overwrites the served ZIP in place, so uploading an older build
 * silently replaces a newer production release and every client is then offered the stale
 * extension. That is exactly what happened on 2026-08-22: v3.9.20 was being served while v3.9.25
 * was the real latest, and nothing in the upload path noticed.
 *
 * The guard compares against everything currently published — every served docroot's ZIP AND
 * the DB release row — and blocks anything older than the newest of them. Deliberate rollback
 * stays possible via ?allowDowngrade=1.
 *
 * These assertions drive the REAL decision function the route calls (decidePublish), not a copy
 * of it, so they cannot drift from production behaviour.
 */
const test = require('node:test');
const assert = require('node:assert');

const { isOlder, isValidVersion } = require('../utils/semver');
const { decidePublish } = require('../utils/extensionDownloads');

// dbVersion = the DB release row; diskVersion = what the docroots serve.
function shouldBlock(uploadedVersion, dbVersion, diskVersion, allowDowngrade = false, { sameBytes = true } = {}) {
  const artifacts = diskVersion ? [{ version: diskVersion, sha256: `sha-${diskVersion}` }] : [];
  const upSha = sameBytes ? `sha-${uploadedVersion}` : 'different-bytes';
  return !decidePublish({ version: uploadedVersion, sha256: upSha },
    { artifacts, dbVersion, dbSha256: dbVersion ? `sha-${dbVersion}` : null }, allowDowngrade).ok;
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

test('re-uploading the SAME build is allowed; the same version with DIFFERENT bytes is not', () => {
  // Identical bytes = idempotent re-publish (also how drifted docroots are repaired).
  assert.strictEqual(shouldBlock('3.9.25', '3.9.25', '3.9.25'), false);
  // One version must map to one package — otherwise "v3.9.25" names two different builds and the
  // ?v= download cache key serves whichever a browser saw first.
  assert.strictEqual(shouldBlock('3.9.25', '3.9.25', '3.9.25', false, { sameBytes: false }), true);
  assert.strictEqual(shouldBlock('3.9.25', '3.9.25', '3.9.25', true, { sameBytes: false }), false);
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
