'use strict';
/**
 * A DEFERRED send must get a budget long enough to actually finish, and a failed one must
 * leave a visible trace. These two properties are what turn a delivery outage from silent
 * into diagnosable, and their absence is why the same bug shipped twice.
 *
 * WHAT WENT WRONG (measured in production 2026-07-30/31, twice in four days).
 *
 * The 2.5s cap in utils/email.js exists for ONE reason: a send that an HTTP request is
 * WAITING ON must fail before LiteSpeed kills the worker and serves its own CORS-less 503.
 * That is a real constraint and the cap is correct — for that case.
 *
 * Then 97eb3e6 moved signup and renewal sends OFF the request path (utils/deferredSend.js).
 * Nothing waits on them any more: there is no worker to kill and no 503 to avoid. But the
 * cap stayed. So every deferred send still had to complete inside 2.5s, and on a host where
 * a healthy send takes ~1.1s but a loaded one takes longer, the abort fired and the mail was
 * discarded — AFTER the user had already been told "we're sending your code".
 *
 * Live evidence: five consecutive production signups accepted the pending row and returned
 * 202, and `lastSentAt` (stamped ONLY by markSignupSent, ONLY on provider acceptance) was
 * never set on any of them. No email arrived; nothing surfaced the failure.
 *
 * Run: node --test tests/deferredSendBudget.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Module = require('module');
const fs = require('fs');
const path = require('path');

// ── A server that always stalls, so only the CAP decides when the call returns ──
let server, PORT;
const sockets = [];
test.before(async () => {
  server = http.createServer(() => { /* never respond */ });
  server.on('connection', (s) => sockets.push(s));
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  PORT = server.address().port;
});
test.after(() => {
  try { server.close(); } catch (_) {}
  for (const s of sockets) { try { s.destroy(); } catch (_) {} }
});

function loadMailer({ requestMs, deferredMs } = {}) {
  const resolved = require.resolve('../utils/email.js');
  delete require.cache[resolved];
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_FROM = 'Test <noreply@example.com>';
  if (requestMs === undefined) delete process.env.EMAIL_TIMEOUT_MS;
  else process.env.EMAIL_TIMEOUT_MS = String(requestMs);
  if (deferredMs === undefined) delete process.env.EMAIL_DEFERRED_TIMEOUT_MS;
  else process.env.EMAIL_DEFERRED_TIMEOUT_MS = String(deferredMs);

  const src = fs.readFileSync(resolved, 'utf8')
    .replace("const RESEND_ENDPOINT = 'https://api.resend.com/emails';",
             `const RESEND_ENDPOINT = 'http://127.0.0.1:${PORT}/emails';`);
  const m = new Module(resolved);
  m.filename = resolved;
  m.paths = Module._nodeModulePaths(path.dirname(resolved));
  m._compile(src, resolved);
  return m.exports;
}

// ── 1. The defect itself ─────────────────────────────────────────────────────

test('a DEFERRED send is NOT capped at the request budget — the silent-loss regression', async () => {
  // THE REGRESSION. Against the old code this returned EMAIL_TIMEOUT at ~2.5s, which is the
  // send being thrown away while the user has already been told it is on its way. The point
  // is not that a stalled send eventually fails — it is that it must be given materially
  // longer than the request path before it does.
  const mailer = loadMailer({ deferredMs: 6000 });
  const t0 = Date.now();
  const r = await mailer.sendEmail({ to: 'a@b.com', subject: 'S', text: 't', deferred: true });
  const ms = Date.now() - t0;

  assert.ok(ms > 3500,
    `a deferred send must outlive the 2.5s request cap; it returned after ${ms}ms (old code: ~2500ms)`);
  assert.equal(r.code, 'EMAIL_TIMEOUT', 'it still fails structurally rather than hanging forever');
});

test('a REQUEST-path send keeps the short cap — the 503 protection must not regress', async () => {
  // The other half of the contract. Widening the deferred budget must not widen this one:
  // an inline send that outlives the worker-kill window produces the opaque CORS-less 503
  // that started this whole saga.
  const mailer = loadMailer({});
  const t0 = Date.now();
  const r = await mailer.sendEmail({ to: 'a@b.com', subject: 'S', text: 't' });
  const ms = Date.now() - t0;
  assert.equal(r.code, 'EMAIL_TIMEOUT');
  assert.ok(ms < 3500, `inline sends must still abort inside the kill window, took ${ms}ms`);
});

test('the deferred budget defaults to something usable, not the request budget', () => {
  const mailer = loadMailer({});
  const d = mailer.diagnostics();
  assert.ok(d.deferredTimeoutMs >= 10000,
    `deferred default must leave real room to finish, got ${d.deferredTimeoutMs}ms`);
  assert.ok(d.deferredTimeoutMs > d.effectiveTimeoutMs,
    'the deferred budget must be strictly longer than the request budget');
});

test('the deferred budget is clamped too, so a wild env value cannot hang a worker forever', () => {
  const mailer = loadMailer({ deferredMs: 999999 });
  const d = mailer.diagnostics();
  assert.equal(d.deferredTimeoutMs, d.deferredCeilingMs);
  assert.equal(d.deferredClamped, true);
});

test('health reports BOTH budgets, so an un-landed deploy is visible from outside', () => {
  const mailer = loadMailer({});
  const d = mailer.diagnostics();
  for (const k of ['effectiveTimeoutMs', 'deferredTimeoutMs', 'ceilingMs', 'deferredCeilingMs']) {
    assert.ok(typeof d[k] === 'number', `${k} is reported`);
  }
  // The pre-existing field names must survive: deploy verification greps on them.
  assert.ok(Object.prototype.hasOwnProperty.call(d, 'envTimeoutMs'));
  assert.ok(Object.prototype.hasOwnProperty.call(d, 'clamped'));
});

// ── 2. Every deferred call site must actually opt in ─────────────────────────

/** Text of each sendAfterResponse(...) call, matched by balancing parentheses. */
function deferredBlocks(src) {
  const out = [];
  const re = /sendAfterResponse\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

test('every send INSIDE a sendAfterResponse callback passes deferred:true', () => {
  // A route that defers its send but forgets the flag silently inherits the 2.5s cap and
  // reintroduces exactly this bug. That is invisible in review, so it is asserted here.
  //
  // Scoped to the deferred CALLBACK, not the file: the same modules legitimately contain
  // inline awaited sends (forgot-password, the legacy signup-resume branch) which MUST keep
  // the short cap, because a request really is waiting on those.
  const ROUTES = path.join(__dirname, '..', 'routes');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(ROUTES);

  const offenders = [];
  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const block of deferredBlocks(src)) {
      // Strip comments so prose mentioning a sender name is never mistaken for a call.
      const code = block.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const calls = code.match(/\bsend[A-Z]\w*Email\s*\(/g) || [];
      for (const c of calls) {
        checked += 1;
        const at = code.indexOf(c);
        const call = code.slice(at, at + 400);
        if (!/deferred:\s*true/.test(call)) {
          offenders.push(`${path.relative(ROUTES, f)}: ${c.trim()}`);
        }
      }
    }
  }
  assert.ok(checked >= 3, `the scan must actually find the deferred sends, found ${checked}`);
  assert.deepEqual(offenders, [],
    `these deferred send sites do not pass deferred:true, so they silently keep the 2.5s cap:\n  ${offenders.join('\n  ')}`);
});

test('inline (awaited) sends must NOT be marked deferred — the 503 guard depends on it', () => {
  // The mirror of the test above. forgot-password awaits its send on the request path; giving
  // it the long budget would hand back the opaque CORS-less 503 this whole design avoids.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'authEmail.js'), 'utf8');
  const deferred = deferredBlocks(src).join('\n');
  const inline = src.split('\n').filter((l) => !deferred.includes(l)).join('\n');
  const resetCall = inline.match(/sendPasswordResetEmail\s*\([^)]*\)/);
  assert.ok(resetCall, 'forgot-password still sends inline');
  assert.ok(!/deferred:\s*true/.test(resetCall[0]),
    'the inline password-reset send must keep the short request budget');
});

// ── 3. The provider check that makes this diagnosable in one call ────────────

test('verifyProvider reports a revoked key as EMAIL_AUTH_FAILED, without sending anything', async () => {
  const mailer = loadMailer({});
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ name: 'validation_error', message: 'API key is invalid' }),
      { status: 401, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await mailer.verifyProvider();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EMAIL_AUTH_FAILED');
    assert.ok(calls.every((u) => !u.includes('/emails')), 'the check must never send an email');
    assert.ok(typeof r.latencyMs === 'number', 'latency is reported so "slow" is distinguishable from "blocked"');
  } finally { globalThis.fetch = realFetch; }
});

test('verifyProvider flags an unverified SENDING domain even when the call succeeds', async () => {
  process.env.EMAIL_FROM = 'Test <noreply@example.com>';
  const mailer = loadMailer({});
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ data: [{ name: 'example.com', status: 'pending', region: 'us-east-1' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const r = await mailer.verifyProvider();
    assert.equal(r.ok, false, 'a reachable provider with an unusable sending domain is NOT healthy');
    assert.equal(r.code, 'EMAIL_DOMAIN_UNVERIFIED');
    assert.equal(r.sendingVerified, false);
  } finally { globalThis.fetch = realFetch; }
});

test('verifyProvider never leaks the API key', async () => {
  const mailer = loadMailer({});
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'nope' }), { status: 403 });
  try {
    const serialized = JSON.stringify(await mailer.verifyProvider());
    assert.ok(!serialized.includes('test-key'), 'the key must never appear in the result');
  } finally { globalThis.fetch = realFetch; }
});
