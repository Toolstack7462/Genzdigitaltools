'use strict';
/**
 * The WriteHuman device-sync migration must be additive, idempotent, and incapable of touching the
 * live session.
 *
 * The last point is the one that matters. This rollout exists because a working cookie bundle was
 * at risk of being overwritten; a migration that could clobber `sessionEncrypted` would reintroduce
 * exactly that risk at the worst possible moment — during the deploy, before any device is paired
 * to recover from it. So "never writes a protected field" is asserted directly rather than assumed
 * from reading the code.
 *
 * No database: planFor is a pure function over one document.
 */
const test = require('node:test');
const assert = require('node:assert');
const { planFor, assertSafe, DEFAULTS, PROTECTED } = require('../scripts/writehuman-device-sync-migrate');

/** An account as it exists in production TODAY — before any multi-device field exists. */
function legacyAccount() {
  return {
    _id: 'acct1', tool: 'writehuman', label: 'WriteHuman', isPrimary: true,
    status: 'active', session_status: 'working',
    sessionEncrypted: 'v1:ciphertext-of-the-live-session',
    sessionMeta: { cookieCount: 24, updatedAt: new Date() },
    cookieHash: 'abc123',
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200 },
    lastVerifiedAt: new Date(),
    // Fields the OLD single-agent code wrote, which must survive untouched.
    lastSyncedAt: new Date('2026-07-17T00:00:00Z'),
    syncCount: 4211,
    agentReport: { cdp: '200', authCookies: 2 },
  };
}

test('a legacy account gains every new field, and nothing else', () => {
  const a = legacyAccount();
  const { changed, patch } = planFor(a);
  assert.strictEqual(changed, true);
  for (const k of Object.keys(DEFAULTS)) assert.ok(k in patch, `initialises ${k}`);
  for (const k of Object.keys(patch)) assert.ok(k in DEFAULTS, `does not invent ${k}`);
});

test('the plan can never mention a field that describes the live session', () => {
  const a = legacyAccount();
  const { patch } = planFor(a);
  for (const k of PROTECTED) assert.ok(!(k in patch), `must not write ${k}`);
  assert.doesNotThrow(() => assertSafe(patch));
  // And the guard itself must actually fire.
  assert.throws(() => assertSafe({ sessionEncrypted: 'x' }), /protected field/);
});

test('applying the plan leaves the active bundle byte-identical', () => {
  const a = legacyAccount();
  const before = a.sessionEncrypted;
  const meta = a.sessionMeta;
  const hash = a.cookieHash;
  Object.assign(a, planFor(a).patch);
  assert.strictEqual(a.sessionEncrypted, before, 'the encrypted session is untouched');
  assert.strictEqual(a.sessionMeta, meta);
  assert.strictEqual(a.cookieHash, hash);
  assert.strictEqual(a.session_status, 'working', 'status is untouched');
});

test('the old single-agent fields survive — history is not erased', () => {
  const a = legacyAccount();
  const syncedAt = a.lastSyncedAt;
  Object.assign(a, planFor(a).patch);
  assert.strictEqual(a.lastSyncedAt, syncedAt, 'the 38-day-old timestamp is preserved as evidence');
  assert.strictEqual(a.syncCount, 4211);
  assert.deepStrictEqual(a.agentReport, { cdp: '200', authCookies: 2 });
});

test('it is idempotent — a second run is a no-op', () => {
  const a = legacyAccount();
  Object.assign(a, planFor(a).patch);
  const second = planFor(a);
  assert.strictEqual(second.changed, false, 'nothing left to do');
  assert.deepStrictEqual(second.patch, {});
});

test('an already-initialised field is never rewritten', () => {
  const a = legacyAccount();
  // Simulate a partial run, or a device paired before the migration was executed.
  a.syncDevices = [{ deviceId: 'dev_existing', name: 'RDP-01' }];
  a.bundleVersion = 7;
  const { patch } = planFor(a);
  assert.ok(!('syncDevices' in patch), 'existing device registry left alone');
  assert.ok(!('bundleVersion' in patch), 'existing version left alone');
  Object.assign(a, patch);
  assert.strictEqual(a.syncDevices.length, 1);
  assert.strictEqual(a.bundleVersion, 7);
});

test('a falsy-but-present value counts as initialised, not missing', () => {
  // bundleVersion 0 and activeSource null are legitimate initialised states. A truthiness check
  // here would rewrite them on every run and quietly break idempotency.
  const a = legacyAccount();
  a.bundleVersion = 0;
  a.activeSource = null;
  const { patch } = planFor(a);
  assert.ok(!('bundleVersion' in patch), '0 is a value, not an absence');
  assert.ok(!('activeSource' in patch), 'null is a value, not an absence');
});
