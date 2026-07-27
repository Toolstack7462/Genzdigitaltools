'use strict';
/**
 * One-time POST launch bootstrap — code lifecycle, atomic single-use redemption, and the
 * CSRF gate on the launch routes.
 *
 * WHAT THESE PIN
 * 1. A launch code is single-use. The failure mode this guards is subtle: the MySQL adapter's
 *    findOneAndUpdate is a read-then-write in JavaScript, so the obvious `{used:false} →
 *    {used:true}` design lets two concurrent redemptions BOTH succeed — a double-click is
 *    enough. Redemption is therefore a DELETE by primary key, whose affectedRows is exact.
 *    `concurrent redemptions` below fails against that naive design and passes against this one.
 * 2. A code is dead the moment it is used (replay → launch_code_used) and dead when it ages out
 *    (30–60s window, clamped).
 * 3. The raw code is never persisted — only its SHA-256 digest — so a database read cannot
 *    replay a launch.
 * 4. The launch routes reject a request with no/incorrect CSRF token, which is what stops a
 *    cross-site form POST minting leases with the victim's SameSite=None auth cookie.
 *
 * Runs against a fake in-memory pool (no real DB), driving the REAL model + store + middleware.
 *
 * Run: node --test tests/launchBootstrap.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';

const adapter = require('../db/mysqlAdapter');

// ── Fake pool: a real-enough `launch_codes` table ────────────────────────────
// It must model the two behaviours the design depends on: an upsert keyed by the primary key,
// and a DELETE whose affectedRows is 1 only for the caller that actually removed the row.
function makeFakePool() {
  const tables = new Map(); // tableName -> Map(id -> {data, createdAt, updatedAt})
  const stats = { deletes: 0 };
  function tbl(name) { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); }
  function tableOf(sql) { const m = sql.match(/`([a-z_]+)`/i); return m ? m[1] : 'unknown'; }

  const pool = {
    query: async (sql, params = []) => {
      const name = tableOf(sql);
      const t = tbl(name);
      if (/^\s*INSERT/i.test(sql)) {
        const [id, data, createdAt, updatedAt] = params;
        t.set(String(id), { data, createdAt, updatedAt });
        return [{ affectedRows: 1 }];
      }
      if (/^\s*DELETE/i.test(sql)) {
        stats.deletes += 1;
        const id = String(params[0]);
        const existed = t.delete(id);
        return [{ affectedRows: existed ? 1 : 0 }];   // exactly MySQL's DELETE semantics
      }
      if (/^\s*SELECT/i.test(sql)) {
        if (/WHERE id = \?/i.test(sql)) {
          const row = t.get(String(params[0]));
          return [row ? [{ data: row.data }] : []];
        }
        if (/WHERE id IN/i.test(sql)) {
          const want = new Set(params.map(String));
          return [[...t.entries()].filter(([k]) => want.has(k)).map(([, v]) => ({ data: v.data }))];
        }
        return [[...t.values()].map(v => ({ data: v.data }))];
      }
      return [[]];
    },
  };
  return { pool, tables, stats, tbl };
}

const fake = makeFakePool();
adapter.__test.setPool(fake.pool);

const lc = require('../utils/launchCode');
const launchStore = require('../utils/launchStore');
const LaunchCode = require('../models/LaunchCode');

function rows() { return fake.tbl('launch_codes'); }

test.beforeEach(() => { rows().clear(); });

// ── Code format + storage ────────────────────────────────────────────────────

test('generated codes are high-entropy, unique and URL-safe', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = lc.generate();
    assert.ok(lc.looksValid(c), `code should match the accepted shape: ${c}`);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(c), 'base64url only — safe in a form body and never needs escaping');
    assert.ok(!seen.has(c), 'no repeats');
    seen.add(c);
  }
  // 32 raw bytes → 43 base64url chars.
  assert.equal(Buffer.from(lc.generate(), 'base64url').length, 32);
});

test('the raw code is NEVER persisted — only its digest', async () => {
  const { code } = await launchStore.issue({ module: 'proxy', tool: 'claude', userId: 'u1', leaseId: 'l1' });
  const stored = JSON.stringify([...rows().values()]);
  assert.ok(!stored.includes(code), 'the raw code must not appear anywhere in the stored row');
  assert.ok(stored.includes(lc.fullHash(code)), 'the digest is what is stored');
});

test('TTL is clamped into the 30–60s window', () => {
  const orig = process.env.LAUNCH_CODE_TTL_SECONDS;
  try {
    delete process.env.LAUNCH_CODE_TTL_SECONDS;
    assert.equal(lc.ttlSeconds(), 45, 'default');
    process.env.LAUNCH_CODE_TTL_SECONDS = '5';    assert.equal(lc.ttlSeconds(), 30, 'floor');
    process.env.LAUNCH_CODE_TTL_SECONDS = '3600'; assert.equal(lc.ttlSeconds(), 60, 'ceiling');
    process.env.LAUNCH_CODE_TTL_SECONDS = '50';   assert.equal(lc.ttlSeconds(), 50, 'in range');
    process.env.LAUNCH_CODE_TTL_SECONDS = 'abc';  assert.equal(lc.ttlSeconds(), 45, 'garbage → default');
  } finally {
    if (orig === undefined) delete process.env.LAUNCH_CODE_TTL_SECONDS;
    else process.env.LAUNCH_CODE_TTL_SECONDS = orig;
  }
});

// ── Redemption ───────────────────────────────────────────────────────────────

test('a valid code redeems once and returns its bindings', async () => {
  const { code, expiresAt } = await launchStore.issue({
    module: 'proxy', tool: 'claude', userId: 'u1', clientRefId: 'pc1', accountId: 'acc1', leaseId: 'lease1',
  });
  assert.ok(expiresAt instanceof Date);

  const r = await launchStore.redeem(code);
  assert.equal(r.ok, true);
  assert.deepEqual(
    { module: r.record.module, tool: r.record.tool, userId: r.record.userId, clientRefId: r.record.clientRefId, accountId: r.record.accountId, leaseId: r.record.leaseId },
    { module: 'proxy', tool: 'claude', userId: 'u1', clientRefId: 'pc1', accountId: 'acc1', leaseId: 'lease1' },
  );
});

test('REPLAY: a redeemed code is gone and cannot be redeemed again', async () => {
  const { code } = await launchStore.issue({ module: 'proxy', tool: 'claude', userId: 'u1', leaseId: 'l1' });

  assert.equal((await launchStore.redeem(code)).ok, true);
  assert.equal(rows().size, 0, 'the row is deleted at redemption, not just flagged');

  for (let i = 0; i < 3; i++) {
    const again = await launchStore.redeem(code);
    assert.equal(again.ok, false);
    assert.equal(again.code, 'launch_code_invalid', 'a replay grants nothing, however many times it is tried');
  }
});

test('CONCURRENCY: N simultaneous redemptions of one code produce exactly ONE success', async () => {
  // This is the test that fails against a read-then-write "used" flag.
  for (const N of [2, 8, 32]) {
    rows().clear();
    const { code } = await launchStore.issue({ module: 'proxy', tool: 'claude', userId: 'u1', leaseId: 'l1' });
    const results = await Promise.all(Array.from({ length: N }, () => launchStore.redeem(code)));
    const wins = results.filter(r => r.ok);
    assert.equal(wins.length, 1, `exactly one of ${N} concurrent redemptions may succeed`);
    for (const loser of results.filter(r => !r.ok)) {
      assert.ok(['launch_code_used', 'launch_code_invalid'].includes(loser.code), `loser got ${loser.code}`);
    }
    assert.equal(rows().size, 0);
  }
});

test('an expired code is refused and cleaned up', async () => {
  const { code } = await launchStore.issue({ module: 'proxy', tool: 'claude', userId: 'u1', leaseId: 'l1' });
  // Age the stored row past its expiry without waiting.
  const id = lc.idOf(code);
  const row = await LaunchCode.findById(id);
  row.expiresAt = new Date(Date.now() - 1000);
  await row.save();

  const r = await launchStore.redeem(code);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'launch_code_expired');
  assert.equal(rows().size, 0, 'an expired code is removed, not left to be retried');
});

test('a code that never existed, or is malformed, is refused without touching the database', async () => {
  const before = fake.stats.deletes;
  for (const bad of [undefined, null, '', 'short', 'has spaces in it', 'x'.repeat(500), 'bad/chars+here=====', 12345, {}]) {
    const r = await launchStore.redeem(bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'launch_code_invalid', `rejected: ${String(bad)}`);
  }
  assert.equal(fake.stats.deletes, before, 'malformed input is rejected by shape, before any DELETE');
});

test('a code whose stored digest does not match is refused (truncated-id collision guard)', async () => {
  const { code } = await launchStore.issue({ module: 'proxy', tool: 'claude', userId: 'u1', leaseId: 'l1' });
  // Simulate a different code colliding on the truncated id: keep the row id, change the digest.
  const row = await LaunchCode.findById(lc.idOf(code));
  row.codeHash = 'f'.repeat(64);
  await row.save();

  const r = await launchStore.redeem(code);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'launch_code_invalid');
  assert.equal(rows().size, 1, 'a non-matching digest must NOT consume the real row');
});

test('codes from different launches are independent', async () => {
  const a = await launchStore.issue({ module: 'proxy', tool: 'claude', userId: 'u1', leaseId: 'lA' });
  const b = await launchStore.issue({ module: 'stealth', tool: 'stealth', userId: 'u2', leaseId: 'lB' });

  assert.equal((await launchStore.redeem(a.code)).ok, true);
  const rb = await launchStore.redeem(b.code);
  assert.equal(rb.ok, true, "one client's launch must not consume another's");
  assert.equal(rb.record.module, 'stealth');
  assert.equal(rb.record.leaseId, 'lB');
});

test('sweepExpired removes only aged-out codes', async () => {
  const live = await launchStore.issue({ module: 'proxy', tool: 'claude', userId: 'u1', leaseId: 'l1' });
  const dead = await launchStore.issue({ module: 'proxy', tool: 'claude', userId: 'u2', leaseId: 'l2' });
  const dr = await LaunchCode.findById(lc.idOf(dead.code));
  dr.expiresAt = new Date(Date.now() - 60000);
  await dr.save();

  const removed = await launchStore.sweepExpired();
  assert.equal(removed, 1);
  assert.equal((await launchStore.redeem(live.code)).ok, true, 'the live code still works');
});

// ── Rollout flags ────────────────────────────────────────────────────────────

test('the POST flow SHIPS DARK: off unless LAUNCH_FLOW=post is set explicitly', () => {
  // REGRESSION GUARD. This defaulted to `post` and caused a live incident: the backend
  // auto-deploys on a push to main, so it went live minutes ahead of the static frontend and
  // the two gateway apps. The old frontend could not send a CSRF header or read the `launch`
  // response, so every Claude/StealthWriter launch broke until the other surfaces caught up.
  // A feature spanning deploy surfaces that cannot ship atomically must default OFF.
  const saved = { f: process.env.LAUNCH_FLOW, t: process.env.LAUNCH_FLOW_TOOLS, s: process.env.STEALTH_LAUNCH_FLOW };
  try {
    delete process.env.LAUNCH_FLOW; delete process.env.LAUNCH_FLOW_TOOLS; delete process.env.STEALTH_LAUNCH_FLOW;

    // Default: EVERYTHING stays on the original URL flow.
    assert.equal(lc.postFlowEnabled('proxy', 'claude'), false, 'Claude must default to the URL flow');
    assert.equal(lc.postFlowEnabled('stealth'), false, 'StealthWriter must default to the URL flow');
    for (const other of ['hix', 'bypassgpt', 'grok', 'chatgpt', 'ryne', 'writehuman']) {
      assert.equal(lc.postFlowEnabled('proxy', other), false, `${other} must keep the URL flow`);
    }
    // Even a per-module opt-in cannot switch it on while the master switch is off.
    process.env.STEALTH_LAUNCH_FLOW = 'post';
    assert.equal(lc.postFlowEnabled('stealth'), false, 'the master switch gates every module');
    delete process.env.STEALTH_LAUNCH_FLOW;

    // Turned ON explicitly: Claude + StealthWriter, and nothing else.
    process.env.LAUNCH_FLOW = 'post';
    assert.equal(lc.postFlowEnabled('proxy', 'claude'), true);
    assert.equal(lc.postFlowEnabled('stealth'), true);
    for (const other of ['hix', 'bypassgpt', 'grok', 'chatgpt', 'ryne', 'writehuman']) {
      assert.equal(lc.postFlowEnabled('proxy', other), false, `${other} must still keep the URL flow`);
    }

    // Global rollback returns everything to the URL flow in one env change.
    process.env.LAUNCH_FLOW = 'url';
    assert.equal(lc.postFlowEnabled('proxy', 'claude'), false);
    assert.equal(lc.postFlowEnabled('stealth'), false);

    // Per-module rollback, with the master switch on.
    process.env.LAUNCH_FLOW = 'post';
    process.env.STEALTH_LAUNCH_FLOW = 'url';
    assert.equal(lc.postFlowEnabled('stealth'), false);
    assert.equal(lc.postFlowEnabled('proxy', 'claude'), true, 'rolling StealthWriter back must not affect Claude');
    delete process.env.STEALTH_LAUNCH_FLOW;

    // Opt another tool in explicitly.
    process.env.LAUNCH_FLOW_TOOLS = 'claude,hix';
    assert.equal(lc.postFlowEnabled('proxy', 'hix'), true);
    assert.equal(lc.postFlowEnabled('proxy', 'grok'), false);
  } finally {
    for (const [k, v] of [['LAUNCH_FLOW', saved.f], ['LAUNCH_FLOW_TOOLS', saved.t], ['STEALTH_LAUNCH_FLOW', saved.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ── CSRF gate ────────────────────────────────────────────────────────────────

test('requireCsrf rejects a missing, absent-cookie or mismatched token and accepts a match', () => {
  const csrf = require('../middleware/csrf');
  const saved = process.env.LAUNCH_CSRF_ENFORCE;
  process.env.LAUNCH_CSRF_ENFORCE = '1';   // enforcement is opt-in; see the dark-ship test below
  const restore = () => { if (saved === undefined) delete process.env.LAUNCH_CSRF_ENFORCE; else process.env.LAUNCH_CSRF_ENFORCE = saved; };
  const run = (headers, cookies) => {
    let status = null, body = null, nexted = false;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    csrf.requireCsrf({ headers, cookies, method: 'POST', path: '/open' }, res, () => { nexted = true; });
    return { status, body, nexted };
  };
  const NAME = csrf.COOKIE_NAME;

  try {
    assert.equal(run({}, {}).status, 403, 'no header → blocked');
    assert.equal(run({}, {}).body.code, 'csrf_invalid');
    assert.equal(run({ 'x-csrf-token': 'abc' }, {}).status, 403, 'header but no cookie → blocked');
    assert.equal(run({ 'x-csrf-token': 'abc' }, { [NAME]: 'different' }).status, 403, 'mismatch → blocked');
    // A cross-site form POST is exactly the "no header" case above — it cannot set one.
    assert.equal(run({ 'x-csrf-token': 'abc123' }, { [NAME]: 'abc123' }).nexted, true, 'matching pair → allowed');
  } finally { restore(); }
});

// ── Redemption endpoint: authorization is RE-CHECKED, not trusted from click time ──
// The code is minted when the client clicks; the lease is signed when the gateway redeems,
// seconds later. In between, an admin may have revoked the lease, disabled the client or let
// the plan lapse. These drive the REAL router to prove a launch can never out-run that.

test('POST /redeem-launch re-validates the lease and client before signing anything', async () => {
  process.env.PROXY_LEASE_SECRET = process.env.PROXY_LEASE_SECRET || 'p'.repeat(48);
  process.env.PROXY_GATEWAY_KEY = process.env.PROXY_GATEWAY_KEY || 'g'.repeat(32);

  const express = require('express');
  const http = require('http');
  const ProxyLease = require('../models/proxy/ProxyLease');
  const ProxyClient = require('../models/proxy/ProxyClient');
  const leaseUtil = require('../utils/proxy/lease');

  const app = express();
  app.use(express.json());
  app.use('/gw', require('../routes/proxy/gateway'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;

  const call = (body, headers) => new Promise((resolve) => {
    const buf = Buffer.from(JSON.stringify(body));
    const r = http.request({
      port, path: '/gw/redeem-launch', method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': buf.length }, headers || {}),
    }, (res) => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', () => resolve({ status: 0, body: {} }));
    r.end(buf);
  });
  const KEY = { 'x-gateway-key': process.env.PROXY_GATEWAY_KEY };

  // A live, fully-authorized launch.
  async function seed(overrides = {}) {
    const client = await ProxyClient.create(Object.assign({ userId: 'u1', tool: 'claude', status: 'active', expiryDate: null }, overrides.client || {}));
    const lease = await ProxyLease.create(Object.assign({
      tool: 'claude', userId: 'u1', proxyClientId: client._id, accountId: 'acc1',
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60 * 1000), revoked: false,
    }, overrides.lease || {}));
    const { code } = await launchStore.issue({ module: 'proxy', tool: 'claude', userId: 'u1', clientRefId: client._id, accountId: 'acc1', leaseId: lease._id });
    return { client, lease, code };
  }

  try {
    // ── The gateway key is the only way in ──
    const s0 = await seed();
    assert.equal((await call({ code: s0.code }, {})).status, 403, 'no gateway key → refused');
    assert.equal((await call({ code: s0.code }, { 'x-gateway-key': 'wrong-key-value-here-0000000000' })).status, 403, 'wrong key → refused');

    // ── Happy path ──
    const s1 = await seed();
    const ok = await call({ code: s1.code }, KEY);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.ok(ok.body.lease, 'a lease token is returned to the GATEWAY (never to a browser)');
    const decoded = leaseUtil.verifyLease(ok.body.lease);
    assert.ok(decoded, 'the token verifies against the lease secret');
    assert.equal(String(decoded.jti), String(s1.lease._id), 'bound to the lease row that was authorized');
    assert.equal(decoded.tool, 'claude');
    assert.ok(ok.body.secondsRemaining <= 30 * 60 && ok.body.secondsRemaining > 0, 'signed for the REMAINING life of the row, so it cannot outlive it');
    // The row's tokenHash is refreshed — the raw token is still never stored.
    const after = await ProxyLease.findById(s1.lease._id);
    assert.equal(after.tokenHash, leaseUtil.hashToken(ok.body.lease));
    assert.ok(!JSON.stringify(after.toObject()).includes(ok.body.lease), 'the raw token is not persisted');

    // ── Replay of the same code, now that it is spent ──
    const replay = await call({ code: s1.code }, KEY);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.code, 'launch_code_invalid');

    // ── Revocation between click and landing ──
    const s2 = await seed();
    const l2 = await ProxyLease.findById(s2.lease._id); l2.revoked = true; await l2.save();
    const r2 = await call({ code: s2.code }, KEY);
    assert.equal(r2.status, 403);
    assert.equal(r2.body.code, 'lease_revoked', 'an admin revoke still wins after the code was minted');
    assert.equal(r2.body.lease, undefined, 'and nothing is signed');

    // ── Lease expiry between click and landing ──
    const s3 = await seed({ lease: { expiresAt: new Date(Date.now() - 1000) } });
    const r3 = await call({ code: s3.code }, KEY);
    assert.equal(r3.status, 403);
    assert.equal(r3.body.code, 'lease_expired');

    // ── Client disabled between click and landing ──
    const s4 = await seed();
    const c4 = await ProxyClient.findById(s4.client._id); c4.status = 'disabled'; await c4.save();
    const r4 = await call({ code: s4.code }, KEY);
    assert.equal(r4.status, 403);
    assert.equal(r4.body.code, 'client_disabled');

    // ── Plan expired between click and landing ──
    const s5 = await seed({ client: { expiryDate: new Date(Date.now() - 48 * 3600 * 1000) } });
    const r5 = await call({ code: s5.code }, KEY);
    assert.equal(r5.status, 403);
    assert.equal(r5.body.code, 'plan_expired');

    // ── A stealth-module code must not redeem on the proxy endpoint ──
    const cross = await launchStore.issue({ module: 'stealth', tool: 'stealth', userId: 'u1', leaseId: 'whatever' });
    const rc = await call({ code: cross.code }, KEY);
    assert.equal(rc.status, 400);
    assert.equal(rc.body.code, 'launch_code_invalid', 'modules cannot be crossed');
  } finally {
    try { server.close(); } catch (_) {}
  }
});

test('CSRF enforcement SHIPS DARK: validates and logs, but only rejects when explicitly enabled', () => {
  // Same regression guard as the launch-flow test above, and for the same incident.
  // Enforcement defaulting to ON meant the auto-deployed backend started demanding a header
  // the still-old frontend had no way to send, 403-ing every launch. It must be an explicit
  // env flip made AFTER the frontend that fetches the token is live.
  const csrf = require('../middleware/csrf');
  const saved = process.env.LAUNCH_CSRF_ENFORCE;
  const warn = console.warn; const seen = []; console.warn = (...a) => seen.push(a.join(' '));
  const attempt = () => {
    let nexted = false, status = null;
    csrf.requireCsrf({ headers: {}, cookies: {}, method: 'POST', path: '/open' },
      { status(s) { status = s; return this; }, json() { return this; } },
      () => { nexted = true; });
    return { nexted, status };
  };
  try {
    delete process.env.LAUNCH_CSRF_ENFORCE;
    assert.equal(csrf.enforcing(), false, 'default is dark');
    assert.equal(attempt().nexted, true, 'a header-less request passes, so an old frontend keeps working');
    assert.ok(seen.some(l => l.includes('would-block')), 'but it is LOGGED, so the flip can be made with evidence');

    process.env.LAUNCH_CSRF_ENFORCE = '0';
    assert.equal(csrf.enforcing(), false, 'explicit 0 is also dark');

    process.env.LAUNCH_CSRF_ENFORCE = '1';
    assert.equal(csrf.enforcing(), true);
    assert.equal(attempt().status, 403, 'and only then does it reject');
  } finally {
    console.warn = warn;
    if (saved === undefined) delete process.env.LAUNCH_CSRF_ENFORCE; else process.env.LAUNCH_CSRF_ENFORCE = saved;
  }
});
