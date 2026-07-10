'use strict';
/**
 * Regression test for the NEW_DEVICE_PENDING false-positive fix in models/DeviceProfile.js.
 * Runs with Node's built-in runner (no jest, no real DB):
 *   node --test backend/tests/deviceProfileResolve.test.js
 *
 * Bug: DeviceProfile.resolve() matched a client's stored profile ONLY by
 * deviceGroupId = sha256(fingerprint). The fingerprint is derived from volatile
 * environment attributes (screen size, colour depth, timezone) that legitimately change
 * on the SAME browser (display scaling, external monitor, HDR toggle, or a browser/ICU
 * update that recanonicalizes the timezone). When it drifted, the previously-approved
 * browser was wrongly funnelled into "pending".
 *
 * Fix: fall back to the stable per-browser instance id (hash of the browser's localStorage
 * device id, already stored on the approved profile) so the same browser stays trusted,
 * while a genuinely new browser (new instance id) still requires approval and a blocked
 * profile still blocks.
 *
 * An in-memory fake pool backs the adapter so resolve()'s real find/create/save run without a DB.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const adapter = require('../db/mysqlAdapter');
const DeviceProfile = require('../models/DeviceProfile');

// Minimal in-memory `device_profiles` store. SELECT returns every row (the adapter always
// re-filters with matchesQuery, exactly like the real JSON-scan fallback); INSERT ... ON
// DUPLICATE KEY UPDATE upserts by id — enough to exercise find(), create() and save().
function makeFakePool() {
  const store = new Map(); // id -> data JSON string
  const pool = {
    query: async (sql, params) => {
      const p = params || [];
      if (/^\s*INSERT INTO `device_profiles`/i.test(sql)) {
        const [id, dataJson] = p;
        store.set(String(id), dataJson);
        return [{ affectedRows: 1 }];
      }
      if (/FROM `device_profiles`/i.test(sql)) {
        return [[...store.values()].map(data => ({ data }))];
      }
      return [[]];
    },
  };
  return { pool, store };
}

const OS = 'Windows';
// The stable per-browser id (what the client persists in localStorage as `device_id`).
const BROWSER_ID = 'stable-browser-uuid-1234';
// A different browser instance on the same machine (its own fresh localStorage id).
const OTHER_BROWSER_ID = 'a-different-browser-uuid-9999';
const FP_ORIGINAL = `${OS}|1920x1080|24|Asia/Kolkata|8|0`;
// Same physical Chrome, but the fingerprint drifted (e.g. display scaling / monitor / ICU tz rename).
const FP_DRIFTED  = `${OS}|1536x864|24|Asia/Calcutta|8|0`;

const CLIENT = { _id: 'client-1', email: 'member@example.com' };

async function seedApproved() {
  const { pool } = makeFakePool();
  adapter.__test.setPool(pool);
  // First login on this browser → auto-approves and records the browser instance id.
  const first = await DeviceProfile.resolve(CLIENT, {
    fingerprint: FP_ORIGINAL, browserInstanceId: BROWSER_ID, os: OS, browser: 'Chrome',
  });
  assert.equal(first.status, 'approved', 'sanity: first device auto-approves');
  return first;
}

test('drifted fingerprint on the SAME approved browser stays approved (the bug)', async () => {
  await seedApproved();
  const decision = await DeviceProfile.resolve(CLIENT, {
    fingerprint: FP_DRIFTED, browserInstanceId: BROWSER_ID, os: OS, browser: 'Chrome',
  });
  assert.equal(decision.status, 'approved', 'same browser must remain trusted despite fingerprint drift');
  assert.equal(decision.reason, 'browser_instance_match', 'matched via the stable browser instance id');
});

test('unchanged fingerprint still matches by deviceGroupId (no behaviour change)', async () => {
  await seedApproved();
  const decision = await DeviceProfile.resolve(CLIENT, {
    fingerprint: FP_ORIGINAL, browserInstanceId: BROWSER_ID, os: OS, browser: 'Chrome',
  });
  assert.equal(decision.status, 'approved');
  assert.notEqual(decision.reason, 'browser_instance_match', 'still matched by fingerprint, not the fallback');
});

test('same physical device in a DIFFERENT browser still matches by deviceGroupId (unchanged)', async () => {
  await seedApproved();
  // Different browser on the same machine → SAME fingerprint, different instance id.
  // This must be handled by the EXISTING deviceGroupId match (not the new fallback).
  const decision = await DeviceProfile.resolve(CLIENT, {
    fingerprint: FP_ORIGINAL, browserInstanceId: OTHER_BROWSER_ID, os: OS, browser: 'Edge',
  });
  assert.equal(decision.status, 'approved', 'same system, new browser stays allowed under the approved profile');
  assert.notEqual(decision.reason, 'browser_instance_match', 'reached via deviceGroupId match, not the fallback');
});

test('a genuinely new browser (new instance id + new fingerprint) still requires approval', async () => {
  await seedApproved();
  const decision = await DeviceProfile.resolve(CLIENT, {
    fingerprint: FP_DRIFTED, browserInstanceId: OTHER_BROWSER_ID, os: OS, browser: 'Firefox',
  });
  assert.equal(decision.status, 'pending', 'unknown browser instance must stay pending admin approval');
});

test('a pending browser stays pending and creates NO duplicate profile on fingerprint drift', async () => {
  const { pool, store } = makeFakePool();
  adapter.__test.setPool(pool);
  // Seed the client's FIRST device (auto-approved) so the next device isn't the first.
  await DeviceProfile.resolve(CLIENT, {
    fingerprint: FP_ORIGINAL, browserInstanceId: BROWSER_ID, os: OS, browser: 'Chrome',
  });
  // A SECOND physical device becomes pending (its own fingerprint + instance id).
  const NEW_FP = `${OS}|1366x768|24|Europe/Kyiv|4|0`;
  const NEW_ID = 'second-device-browser-uuid';
  const first = await DeviceProfile.resolve(CLIENT, {
    fingerprint: NEW_FP, browserInstanceId: NEW_ID, os: OS, browser: 'Chrome',
  });
  assert.equal(first.status, 'pending', 'sanity: a new physical device is pending');
  const countAfterFirst = store.size;
  // Same pending browser logs in again after its fingerprint drifts.
  const drifted = `${OS}|1280x720|24|Europe/Kiev|4|0`;
  const second = await DeviceProfile.resolve(CLIENT, {
    fingerprint: drifted, browserInstanceId: NEW_ID, os: OS, browser: 'Chrome',
  });
  assert.equal(second.status, 'pending', 'still pending — not silently approved');
  assert.equal(store.size, countAfterFirst, 'no duplicate pending profile created for the same browser instance');
});

test('approved wins over a stale pending duplicate that shares the browserInstanceId (order-independent)', async () => {
  const { pool, store } = makeFakePool();
  adapter.__test.setPool(pool);
  // Reproduce an already-affected client: the original approved profile PLUS a stale
  // pending duplicate the drift bug created — BOTH carrying the same browserInstanceId.
  const hashedBrowser = DeviceProfile.sha256(BROWSER_ID);
  const approvedRow = {
    _id: 'p-approved', clientId: CLIENT._id, deviceGroupId: DeviceProfile.sha256(FP_ORIGINAL),
    browserInstanceIds: [hashedBrowser], status: 'approved',
  };
  const pendingDupRow = {
    _id: 'p-pending', clientId: CLIENT._id, deviceGroupId: DeviceProfile.sha256(FP_DRIFTED),
    browserInstanceIds: [hashedBrowser], status: 'pending',
  };
  // Insert the PENDING duplicate FIRST so a naive first-match would wrongly pick it.
  store.set(pendingDupRow._id, JSON.stringify(pendingDupRow));
  store.set(approvedRow._id, JSON.stringify(approvedRow));

  const decision = await DeviceProfile.resolve(CLIENT, {
    fingerprint: `${OS}|800x600|24|Asia/Kolkata|8|0`, // yet another drift → no deviceGroupId match
    browserInstanceId: BROWSER_ID, os: OS, browser: 'Chrome',
  });
  assert.equal(decision.status, 'approved', 'approved profile must win over the stale pending duplicate');
  assert.equal(decision.profile._id, 'p-approved', 'resolved to the approved profile regardless of scan order');
  assert.equal(decision.reason, 'browser_instance_match');
});

test('a blocked profile still blocks when reached via the browser-instance fallback', async () => {
  const { pool, store } = makeFakePool();
  adapter.__test.setPool(pool);
  // Seed a BLOCKED profile that already knows this browser instance.
  await DeviceProfile.resolve(CLIENT, {
    fingerprint: FP_ORIGINAL, browserInstanceId: BROWSER_ID, os: OS, browser: 'Chrome',
  });
  // Admin blocks it: flip the single stored row's status to 'blocked'.
  for (const [id, data] of store) {
    const obj = JSON.parse(data);
    obj.status = 'blocked';
    store.set(id, JSON.stringify(obj));
  }
  const decision = await DeviceProfile.resolve(CLIENT, {
    fingerprint: FP_DRIFTED, browserInstanceId: BROWSER_ID, os: OS, browser: 'Chrome',
  });
  assert.equal(decision.status, 'blocked', 'blocked devices remain blocked even after fingerprint drift');
});
