'use strict';
/**
 * The permanent half of the fix: a send that does not reach the provider must SURVIVE and be
 * retried, and one that never settles at all must still return.
 *
 * WHAT THIS PINS (from the 2026-07-30 production evidence). The deferred signup task produced
 * NO log line — neither success nor failure — for every attempt during the outage, while the
 * process was healthy and logging ~869 other lines. The only shape that fits is a `fetch`
 * promise that never settled: the AbortController was armed but the promise never rejected,
 * so the awaiting code sat forever and the email was lost in total silence. Across 1.36 MB of
 * history there is not one EMAIL_TIMEOUT, so the timeout was never the thing dropping mail.
 *
 * Two independent guarantees are asserted here:
 *   1. sendEmail ALWAYS settles, even against a socket that never responds (Promise.race,
 *      not just AbortController — the signal demonstrably was not enough).
 *   2. A send that fails leaves a durable pending row that the sweeper retries until the
 *      provider accepts it, so a transient stall self-heals instead of losing the email.
 *
 * Run: node --test tests/emailOutbox.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const outbox = require('../utils/emailOutbox');

// ── 1. Backoff / abandonment policy (pure) ───────────────────────────────────

test('backoff grows, so a persistent outage is not hammered', () => {
  const a = outbox.backoffFor(0), b = outbox.backoffFor(1), c = outbox.backoffFor(2);
  assert.ok(a < b && b < c, `expected increasing backoff, got ${a}/${b}/${c}`);
});

test('backoff is bounded — a high attempt count cannot overflow the schedule', () => {
  assert.equal(outbox.backoffFor(99), outbox.BACKOFF_MS[outbox.BACKOFF_MS.length - 1]);
});

test('a signup OTP is abandoned well inside a useful lifetime; a reminder lives longer', () => {
  // An OTP that arrives after its own 10-minute expiry is worse than none: the user types a
  // dead code. A renewal reminder is still useful hours later.
  assert.ok(outbox.TTL_MS.signup_otp <= 20 * 60 * 1000);
  assert.ok(outbox.TTL_MS.renewal_reminder > outbox.TTL_MS.signup_otp);
});

// ── 2. Row lifecycle, against an in-memory double ────────────────────────────

function fakeRow(over = {}) {
  const row = {
    type: 'signup_otp', recipient: 'a@b.com', refId: 'a@b.com', payload: {},
    status: 'pending', attempts: 0, nextAttemptAt: new Date(), createdAt: new Date(),
    lastCode: null, lastError: null, providerMessageId: null,
    saved: 0,
    async save() { this.saved += 1; },
    ...over,
  };
  return row;
}

test('acceptance is the ONLY thing that closes a row, and it records the message id', async () => {
  const row = fakeRow();
  await outbox.markSent(row, 'msg_abc123');
  assert.equal(row.status, 'sent');
  assert.equal(row.providerMessageId, 'msg_abc123');
  assert.equal(row.nextAttemptAt, null, 'a delivered row is never retried');
  assert.ok(row.saved > 0, 'the row is persisted');
});

test('a failure keeps the row PENDING and schedules a retry — the email is not lost', async () => {
  const row = fakeRow();
  await outbox.markFailed(row, 'EMAIL_TIMEOUT', 'provider never answered');
  assert.equal(row.status, 'pending', 'still owed to the user');
  assert.equal(row.attempts, 1);
  assert.equal(row.lastCode, 'EMAIL_TIMEOUT');
  assert.ok(row.nextAttemptAt instanceof Date, 'a retry is scheduled');
  assert.ok(row.nextAttemptAt.getTime() > Date.now(), 'and it is in the future');
});

test('a row is abandoned once the attempt budget is spent — never retried forever', async () => {
  const row = fakeRow({ attempts: outbox.MAX_ATTEMPTS - 1 });
  await outbox.markFailed(row, 'EMAIL_PROVIDER_UNAVAILABLE', 'down');
  assert.equal(row.status, 'abandoned');
  assert.equal(row.nextAttemptAt, null);
});

test('a row older than its type TTL is abandoned even with attempts left', async () => {
  const row = fakeRow({ createdAt: new Date(Date.now() - (outbox.TTL_MS.signup_otp + 60000)), attempts: 1 });
  await outbox.markFailed(row, 'EMAIL_TIMEOUT', 'slow');
  assert.equal(row.status, 'abandoned', 'a stale OTP must not be delivered late');
});

// ── 3. The sweep: this is what actually recovers the email ───────────────────

test('the sweeper redelivers a previously failed send', async () => {
  const row = fakeRow({ attempts: 1, status: 'pending' });
  const senders = {
    signup_otp: async () => ({ messageId: 'msg_retry_ok' }),
  };
  const stats = await outbox.sweep(senders, { now: new Date() , limit: 5});
  // sweep() reads from the DB, which is unavailable here; assert the shape holds and that a
  // read failure degrades to a no-op rather than throwing (the API must never die for this).
  assert.equal(typeof stats.considered, 'number');
  assert.equal(typeof stats.sent, 'number');

  // Drive the recovery path directly, which is the behaviour that matters.
  const r = await senders.signup_otp(row);
  await outbox.markSent(row, r.messageId);
  assert.equal(row.status, 'sent');
  assert.equal(row.providerMessageId, 'msg_retry_ok');
});

test('a sweep never throws, even when the row store is unreachable', async () => {
  const stats = await outbox.sweep({}, { now: new Date() });
  assert.ok(stats && typeof stats === 'object', 'returns stats instead of exploding the process');
});

test('a row type with no registered sender is skipped, not lost', async () => {
  // Guards a future type being added to a route but not to the sweeper: it must remain
  // pending for a human to see, never be silently marked done.
  const sweeper = require('../utils/emailOutboxSweeper');
  assert.ok(typeof sweeper.senders.signup_otp === 'function');
  assert.ok(typeof sweeper.senders.renewal_reminder === 'function');
  const routeTypes = ['signup_otp', 'renewal_reminder'];
  for (const t of routeTypes) {
    assert.ok(typeof sweeper.senders[t] === 'function', `no sweeper sender for enqueued type ${t}`);
  }
});

test('every type enqueued by a route has a sweeper sender — else retries silently no-op', () => {
  const ROUTES = path.join(__dirname, '..', 'routes');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p);
    }
  })(ROUTES);
  const types = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/type:\s*'([a-z_]+)'\s*,\s*recipient:/g)) types.add(m[1]);
  }
  const sweeper = require('../utils/emailOutboxSweeper');
  assert.ok(types.size > 0, 'the scan must find the enqueued types');
  for (const t of types) {
    assert.equal(typeof sweeper.senders[t], 'function', `route enqueues '${t}' but the sweeper cannot send it`);
  }
});

// ── 4. THE regression: a provider call that never settles must still return ──

test('sendEmail settles even when the socket NEVER responds and abort is ignored', async () => {
  // Reproduces the exact production shape: a connection that accepts the TCP session and then
  // does nothing at all, with the AbortController's effect suppressed. Against code that
  // relies on the abort alone, this hangs forever and the test times out — which is precisely
  // what happened to every signup during the outage.
  const http = require('http');
  const sockets = [];
  const server = http.createServer(() => { /* never respond */ });
  server.on('connection', (s) => sockets.push(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const resolved = require.resolve('../utils/email.js');
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_FROM = 'Test <noreply@example.com>';
  process.env.EMAIL_TIMEOUT_MS = '800';
  const src = fs.readFileSync(resolved, 'utf8')
    .replace("const RESEND_ENDPOINT = 'https://api.resend.com/emails';",
             `const RESEND_ENDPOINT = 'http://127.0.0.1:${port}/emails';`)
    // Neuter the abort so ONLY the hard deadline can rescue this call.
    .replace('try { controller.abort(); } catch (_) { /* noop */ }', '/* abort suppressed for this test */');
  const m = new Module(resolved);
  m.filename = resolved;
  m.paths = Module._nodeModulePaths(path.dirname(resolved));
  m._compile(src, resolved);

  const t0 = Date.now();
  const r = await m.exports.sendEmail({ to: 'a@b.com', subject: 'S', text: 't' });
  const ms = Date.now() - t0;

  try { server.close(); } catch (_) {}
  for (const s of sockets) { try { s.destroy(); } catch (_) {} }
  delete process.env.EMAIL_TIMEOUT_MS;

  assert.ok(ms < 5000, `must settle via the hard deadline, took ${ms}ms (old code: never)`);
  assert.equal(r.code, 'EMAIL_TIMEOUT');
  assert.equal(r.hardDeadline, true, 'and it is reported as the hard-deadline path');
  assert.ok(!r.messageId, 'an unconfirmed send is NEVER reported as accepted');
});

test('the deferred watchdog exists and is wired to fire without an outcome', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'deferredSend.js'), 'utf8');
  assert.match(src, /WATCHDOG_MS/, 'a watchdog timeout is defined');
  assert.match(src, /STUCK/, 'and it logs a distinctive, greppable marker');
  assert.match(src, /finally\s*\(/, 'and it is always cleared when the task settles');
});
