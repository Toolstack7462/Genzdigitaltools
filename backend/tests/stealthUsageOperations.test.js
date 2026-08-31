'use strict';
/**
 * StealthWriter usage lifecycle — RESERVED → COMMITTED / CANCELLED / EXPIRED.
 *   node --test backend/tests/stealthUsageOperations.test.js
 *
 * WHAT THIS PINS
 * A Humanizer/Detector credit used to be spent on the CLICK: the overlay called /consume
 * before the upstream request was dispatched, so a StealthWriter "service is temporarily
 * unavailable due to high demand" still cost the member a credit. utils/stealth/access.js
 * now reserves capacity first and increments the counter ONLY at commit, which the gateway
 * calls only after it has verified a real result.
 *
 * These tests run the REAL model layer over an in-memory fake pool (the adapter's documented
 * __test.setPool seam), so the DELETE-by-primary-key claim — the one thing that makes
 * "commit exactly once" true across workers — is exercised for real rather than mocked.
 *
 * Nothing here contains, or could contain, submitted text or generated output: the lifecycle
 * never sees them.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const adapter = require('../db/mysqlAdapter');

// ── In-memory MySQL stand-in ────────────────────────────────────────────────────────────
// Understands exactly the statements db/mysqlAdapter.js emits, and — critically — reports
// affectedRows for DELETE the way InnoDB does, so only ONE concurrent claimant can win.
function fakePool() {
  const tables = new Map(); // table -> Map(id -> {data, createdAt, updatedAt})
  const t = (name) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  const wrap = (rows) => [rows.map(r => ({ data: r.data }))];
  const tableOf = (sql) => (sql.match(/`([a-z0-9_]+)`/i) || [])[1];

  const pool = {
    query: async (sql, params = []) => {
      const name = tableOf(sql);
      const rows = t(name);
      if (/^\s*INSERT INTO/i.test(sql)) {
        const [id, data, createdAt, updatedAt] = params;
        rows.set(String(id), { data, createdAt, updatedAt });
        return [{ affectedRows: 1 }];
      }
      if (/^\s*DELETE FROM/i.test(sql)) {
        const id = String(params[0]);
        const had = rows.delete(id);
        return [{ affectedRows: had ? 1 : 0 }];
      }
      if (/WHERE id = \?/.test(sql)) {
        const r = rows.get(String(params[0]));
        return wrap(r ? [r] : []);
      }
      if (/WHERE id IN/.test(sql)) {
        const want = new Set(params.map(String));
        return wrap([...rows.entries()].filter(([k]) => want.has(k)).map(([, v]) => v));
      }
      if (/JSON_EXTRACT/.test(sql)) {
        const field = String(params[0]).replace(/^\$\./, '');
        return wrap([...rows.values()].filter(r => JSON.parse(r.data)[field] === params[1]));
      }
      return wrap([...rows.values()]); // full scan
    },
  };
  return { pool, tables };
}

let access, StealthClient, StealthUsageOperation;
function boot() {
  const fp = fakePool();
  adapter.__test.setPool(fp.pool);
  // Fresh module instances so the reservation TTL / retention constants are re-read and no
  // state leaks between cases.
  for (const p of [
    require.resolve('../utils/stealth/access'),
    require.resolve('../models/stealth/StealthUsageOperation'),
    require.resolve('../models/stealth/StealthClient'),
  ]) delete require.cache[p];
  access = require('../utils/stealth/access');
  StealthClient = require('../models/stealth/StealthClient');
  StealthUsageOperation = require('../models/stealth/StealthUsageOperation');
  return fp;
}

async function makeClient({ humanizer = 5, detector = 5, status = 'active', expiryDate = null } = {}) {
  return StealthClient.create({
    userId: 'u1',
    status,
    expiryDate,
    dailyHumanizerLimit: humanizer,
    dailyDetectorLimit: detector,
    usage: { humanizerUsed: 0, detectorUsed: 0, lastResetAt: new Date() },
  });
}
const reload = (c) => StealthClient.findById(c._id);
const used = async (c, action) => {
  const f = await reload(c);
  return action === 'humanizer' ? Number(f.usage.humanizerUsed) : Number(f.usage.detectorUsed);
};
const LEASE = { leaseId: 'lease1', accountId: 'acc1' };

// ── Reserve holds capacity without charging ─────────────────────────────────────────────

test('reserve does NOT move the used counter — the click costs nothing', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  assert.equal(r.ok, true);
  assert.match(r.operationId, /^[0-9a-f]{32}$/, 'cryptographically random operation id');
  assert.equal(await used(c, 'humanizer'), 0, 'nothing is spent until a verified result');
  assert.equal(r.remaining.humanizer, 5, 'the DISPLAYED remaining count is the committed one');
});

test('commit charges exactly once, for the right action only', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  const out = await access.commit(c, 'humanizer', r.operationId, { upstreamStatus: 200 });
  assert.equal(out.committed, true);
  assert.equal(await used(c, 'humanizer'), 1);
  assert.equal(await used(c, 'detector'), 0, 'AI Detector is untouched by a Humanizer commit');
  assert.equal(out.remaining.humanizer, 4);
});

test('cancel leaves the count untouched — the high-demand / failure path', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  const out = await access.cancel(c, 'humanizer', r.operationId, { outcomeCode: 'upstream_status', upstreamStatus: 503 });
  assert.equal(out.cancelled, true);
  assert.equal(await used(c, 'humanizer'), 0);
});

test('AI Detector runs the same lifecycle and touches only the Detector counter', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'detector', LEASE);
  await access.commit(c, 'detector', r.operationId, { upstreamStatus: 200 });
  assert.equal(await used(c, 'detector'), 1);
  assert.equal(await used(c, 'humanizer'), 0);
});

// ── Idempotency ─────────────────────────────────────────────────────────────────────────

test('duplicate commit with the same operation id charges once', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  const a = await access.commit(c, 'humanizer', r.operationId, {});
  const b = await access.commit(c, 'humanizer', r.operationId, {});
  assert.equal(a.committed, true);
  assert.equal(a.duplicate, false);
  assert.equal(b.committed, true, 'the retry is answered with the recorded result');
  assert.equal(b.duplicate, true);
  assert.equal(await used(c, 'humanizer'), 1, 'still exactly one charge');
});

test('a retried commit after a transport failure does not double charge', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  for (let i = 0; i < 5; i++) await access.commit(c, 'humanizer', r.operationId, {}); // the gateway's bounded retry
  assert.equal(await used(c, 'humanizer'), 1);
});

test('duplicate cancel is harmless', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  const a = await access.cancel(c, 'humanizer', r.operationId, {});
  const b = await access.cancel(c, 'humanizer', r.operationId, {});
  assert.equal(a.cancelled, true);
  assert.equal(b.ok, true);
  assert.equal(await used(c, 'humanizer'), 0);
});

test('commit after cancel is refused and charges nothing', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  await access.cancel(c, 'humanizer', r.operationId, {});
  const out = await access.commit(c, 'humanizer', r.operationId, {});
  assert.equal(out.committed, false);
  assert.equal(out.reason, 'operation_cancelled');
  assert.equal(await used(c, 'humanizer'), 0);
});

test('cancel after commit cannot undo valid usage', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  await access.commit(c, 'humanizer', r.operationId, {});
  const out = await access.cancel(c, 'humanizer', r.operationId, {});
  assert.equal(out.committed, true, 'reports the commit rather than reversing it');
  assert.equal(await used(c, 'humanizer'), 1);
});

// ── Forged / stale / unknown operations ─────────────────────────────────────────────────

test('a made-up operation id can never charge', async () => {
  boot();
  const c = await makeClient();
  await access.reserve(c, 'humanizer', LEASE);
  const out = await access.commit(c, 'humanizer', 'f'.repeat(32), {});
  assert.equal(out.committed, false);
  assert.equal(await used(c, 'humanizer'), 0);
});

test('a malformed operation id is rejected without touching the counter', async () => {
  boot();
  const c = await makeClient();
  const out = await access.commit(c, 'humanizer', 'not-an-id', {});
  assert.equal(out.committed, false);
  assert.equal(out.reason, 'operation_invalid');
  assert.equal(await used(c, 'humanizer'), 0);
});

test('an EXPIRED reservation cannot be replayed — gateway restart / abandoned tab', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  const later = new Date(Date.now() + (access.RESERVATION_TTL_SEC + 5) * 1000);
  const out = await access.commit(c, 'humanizer', r.operationId, {}, later);
  assert.equal(out.committed, false);
  assert.equal(out.reason, 'operation_expired');
  assert.equal(await used(c, 'humanizer'), 0);
});

test('an expired reservation releases capacity automatically', async () => {
  boot();
  const c = await makeClient({ humanizer: 1 });
  await access.reserve(c, 'humanizer', { leaseId: 'leaseA' });
  const later = new Date(Date.now() + (access.RESERVATION_TTL_SEC + 5) * 1000);
  const second = await access.reserve(c, 'humanizer', { leaseId: 'leaseB' }, later);
  assert.equal(second.ok, true, 'a stale reservation must not block the member forever');
  assert.equal(await used(c, 'humanizer'), 0);
});

// ── Capacity and concurrency ────────────────────────────────────────────────────────────

test('reserve is refused at the limit, so no upstream request is even attempted', async () => {
  boot();
  const c = await makeClient({ humanizer: 1 });
  const first = await access.reserve(c, 'humanizer', LEASE);
  await access.commit(c, 'humanizer', first.operationId, {});
  const second = await access.reserve(c, 'humanizer', LEASE);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'limit_reached');
  assert.equal(second.operationId, undefined);
  assert.equal(await used(c, 'humanizer'), 1);
});

test('two CONCURRENT attempts with 1 remaining produce at most one charge', async () => {
  boot();
  const c = await makeClient({ humanizer: 1 });
  const [a, b] = await Promise.all([
    access.reserve(c, 'humanizer', { leaseId: 'leaseA' }),
    access.reserve(c, 'humanizer', { leaseId: 'leaseB' }),
  ]);
  const results = await Promise.all(
    [a, b].filter(r => r.ok).map(r => access.commit(c, 'humanizer', r.operationId, {}))
  );
  const charged = results.filter(r => r.committed && !r.duplicate).length;
  assert.ok(charged <= 1, 'never more than one charge for one remaining credit');
  assert.equal(await used(c, 'humanizer'), charged);
  assert.ok(Number((await reload(c)).usage.humanizerUsed) <= 1, 'the limit is never exceeded');
});

test('a second session cannot start while another lease holds the reservation', async () => {
  boot();
  const c = await makeClient({ humanizer: 5 });
  await access.reserve(c, 'humanizer', { leaseId: 'leaseA' });
  const other = await access.reserve(c, 'humanizer', { leaseId: 'leaseB' });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'operation_in_flight');
});

test('the SAME lease supersedes its own reservation, and the superseded id cannot charge', async () => {
  boot();
  const c = await makeClient({ humanizer: 5 });
  const first = await access.reserve(c, 'humanizer', LEASE);   // e.g. the page was reloaded
  const second = await access.reserve(c, 'humanizer', LEASE);
  assert.equal(second.ok, true);
  assert.notEqual(second.operationId, first.operationId);
  const stale = await access.commit(c, 'humanizer', first.operationId, {});
  assert.equal(stale.committed, false, 'the abandoned request can never charge');
  const live = await access.commit(c, 'humanizer', second.operationId, {});
  assert.equal(live.committed, true);
  assert.equal(await used(c, 'humanizer'), 1, 'a rapid double-click charges once, not twice');
});

// ── Authorization is re-checked at both ends ────────────────────────────────────────────

test('a disabled client cannot reserve', async () => {
  boot();
  const c = await makeClient({ status: 'disabled' });
  const r = await access.reserve(c, 'humanizer', LEASE);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'client_disabled');
});

test('an expired plan cannot reserve', async () => {
  boot();
  const c = await makeClient({ expiryDate: new Date(Date.now() - 86400000) });
  const r = await access.reserve(c, 'humanizer', LEASE);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'plan_expired');
});

test('a client disabled DURING the request is not charged at commit', async () => {
  boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  c.status = 'disabled';
  await c.save();
  const out = await access.commit(c, 'humanizer', r.operationId, {});
  assert.equal(out.committed, false);
  assert.equal(await used(c, 'humanizer'), 0);
});

test('an unlimited plan (-1) commits without ever being limit-blocked', async () => {
  boot();
  const c = await makeClient({ humanizer: -1 });
  for (let i = 0; i < 3; i++) {
    const r = await access.reserve(c, 'humanizer', LEASE);
    assert.equal(r.ok, true);
    assert.equal(r.remaining.humanizer, null, 'unlimited stays unlimited');
    await access.commit(c, 'humanizer', r.operationId, {});
  }
  assert.equal(await used(c, 'humanizer'), 3);
});

test('an unknown action never charges anything', async () => {
  boot();
  const c = await makeClient();
  assert.equal((await access.reserve(c, 'summarizer', LEASE)).reason, 'invalid_action');
  assert.equal((await access.commit(c, 'summarizer', 'a'.repeat(32), {})).reason, 'invalid_action');
  assert.equal(await used(c, 'humanizer'), 0);
  assert.equal(await used(c, 'detector'), 0);
});

// ── The durable record itself ───────────────────────────────────────────────────────────

test('the operation record holds ids and status only — never text, cookies or tokens', async () => {
  const fp = boot();
  const c = await makeClient();
  const r = await access.reserve(c, 'humanizer', LEASE);
  await access.commit(c, 'humanizer', r.operationId, { outcomeCode: 'result_envelope', upstreamStatus: 200 });
  const rows = [...fp.tables.get('stealth_usage_operations').values()].map(v => JSON.parse(v.data));
  assert.ok(rows.length >= 1);
  const outcome = rows.find(x => x.kind === 'outcome');
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.outcomeCode, 'result_envelope');
  assert.equal(outcome.upstreamStatus, 200);
  const FORBIDDEN = /(text|prompt|input|output|content|body|cookie|token|password|session|authorization)/i;
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      assert.ok(!FORBIDDEN.test(k), 'no field that could carry member content: ' + k);
    }
  }
});

test('the reservation row is keyed per (client, action), so the two actions never collide', async () => {
  boot();
  const c = await makeClient();
  const h = await access.reserve(c, 'humanizer', LEASE);
  const d = await access.reserve(c, 'detector', LEASE);
  assert.equal(h.ok, true);
  assert.equal(d.ok, true, 'a Humanizer reservation must not block an AI Detector scan');
  assert.notEqual(
    StealthUsageOperation.reservationId(c._id, 'humanizer'),
    StealthUsageOperation.reservationId(c._id, 'detector'),
  );
  await access.commit(c, 'detector', d.operationId, {});
  assert.equal(await used(c, 'detector'), 1);
  assert.equal(await used(c, 'humanizer'), 0);
});

test('reservation ids can never collide with operation ids', async () => {
  boot();
  const rid = StealthUsageOperation.reservationId('client-1', 'humanizer');
  assert.equal(rid.length, 32);
  assert.equal(rid[0], 'r');
  assert.ok(!StealthUsageOperation.isOperationId(rid), 'a reservation id is not a valid operation id');
  assert.ok(StealthUsageOperation.isOperationId(StealthUsageOperation.newOperationId()));
});

test('the sweeper removes only dead rows', async () => {
  const fp = boot();
  const c = await makeClient();
  const live = await access.reserve(c, 'humanizer', LEASE);
  const table = fp.tables.get('stealth_usage_operations');
  assert.equal(table.size, 1);
  await access.sweepUsageOperations(new Date(), true);
  assert.equal(table.size, 1, 'a live reservation survives');
  const wayLater = new Date(Date.now() + (access.RESERVATION_TTL_SEC + access.OUTCOME_RETENTION_SEC + 60) * 1000);
  await access.sweepUsageOperations(wayLater, true);
  assert.equal(table.size, 0, 'long-dead rows are cleaned up');
  assert.ok(live.operationId);
});

// ── The legacy path must keep working for older cached overlays ─────────────────────────

test('legacy /consume behaviour is unchanged', async () => {
  boot();
  const c = await makeClient({ humanizer: 2 });
  const d = await access.consume(c, 'humanizer');
  assert.equal(d.allowed, true);
  assert.equal(await used(c, 'humanizer'), 1, 'still charges immediately, exactly as before');
  assert.equal(d.remaining.humanizer, 1);
});
