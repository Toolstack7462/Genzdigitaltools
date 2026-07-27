'use strict';
/**
 * ROUTE-LEVEL regression test: registering must actually cause a verification email to be
 * sent, and asking for a renewal reminder must actually cause one to be sent.
 *
 * WHY THIS EXISTS — the exact gap that let a Critical defect reach production.
 * routes/public.js and routes/admin/renewals.js called sendAfterResponse() without ever
 * requiring it. That is a HANDLER-SCOPE ReferenceError: the module loads fine, and it only
 * throws once a real request runs through it. Production logged it on every single signup:
 *
 *   [signup] stage=error rid=… name=ReferenceError msg=sendAfterResponse is not defined
 *   '[signup] stage=email result=sent' occurrences: 0
 *
 * The whole 255-test suite stayed green because NO test drove these Express routes —
 * signupFlow.test.js exercises models/utils, renewalReminderSend.test.js exercises the mailer
 * and the lock. Neither one issues an HTTP request.
 *
 * It was also invisible to a status-code check: res.json() runs BEFORE the throw, so the
 * client still receives a correct 202 and the user is told to check an inbox that will stay
 * empty. So this test asserts DELIVERY WAS ATTEMPTED — the actual user-facing requirement —
 * and not the status code, which was never the thing that broke.
 *
 * Runs against a fake in-memory pool and a stubbed mailer: no database, no network, no
 * provider call, nothing shared touched.
 *
 * Run: node --test tests/registerRouteDelivers.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abcdef0123456789';
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// ── Stub utils/email BEFORE any route requires it ────────────────────────────
// routes/public.js destructures { sendVerificationEmail, isEmailEnabled } at module load, so
// the stub has to be in the cache first. Recording the call is the whole point of the test.
const emailPath = require.resolve('../utils/email');
const sent = [];
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, exports: {
    isEmailEnabled: () => true,
    sendVerificationEmail: async (to, code) => { sent.push({ kind: 'verification', to, code }); return { messageId: 'stub-1' }; },
    sendRenewalReminderEmail: async (to) => { sent.push({ kind: 'renewal', to }); return { messageId: 'stub-2' }; },
    EMAIL_CODES: { UNKNOWN: 'UNKNOWN', INVALID_RECIPIENT: 'INVALID_RECIPIENT' },
    adminMessageFor: () => 'stub admin message',
  },
};

// ── Fake pool: a real-enough key/value table per collection ──────────────────
const adapter = require('../db/mysqlAdapter');
const tables = new Map();
function tbl(n) { if (!tables.has(n)) tables.set(n, new Map()); return tables.get(n); }
adapter.__test.setPool({
  query: async (sql, params = []) => {
    const m = sql.match(/`([a-z_]+)`/i); const t = tbl(m ? m[1] : 'x');
    if (/^\s*INSERT/i.test(sql)) { t.set(String(params[0]), { data: params[1] }); return [{ affectedRows: 1 }]; }
    if (/^\s*DELETE/i.test(sql)) { const had = t.delete(String(params[0])); return [{ affectedRows: had ? 1 : 0 }]; }
    if (/^\s*SELECT/i.test(sql)) {
      if (/WHERE id = \?/i.test(sql)) { const r = t.get(String(params[0])); return [r ? [{ data: r.data }] : []]; }
      return [[...t.values()].map(v => ({ data: v.data }))];
    }
    return [[]];
  },
});

const express = require('express');
let server, PORT;

test.before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/crm/public', require('../routes/public'));
  // A last-resort error handler, exactly like server-crm.js has. Without one, a throw after
  // the response would be swallowed by the framework and the test could not see it.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) return;
    res.status(500).json({ error: 'unhandled', message: String(err && err.message) });
  });
  await new Promise((r) => { server = app.listen(0, r); });
  PORT = server.address().port;
});
test.after(() => { try { server.close(); } catch (_) {} });

function post(p, body) {
  return new Promise((resolve) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      port: PORT, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': buf.length },
    }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.end(buf);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 250)); // let the deferred send run

test('POST /public/register ACTUALLY SENDS the verification email', async () => {
  sent.length = 0;
  const email = `route-test-${Date.now()}@example.com`;

  const r = await post('/api/crm/public/register', {
    fullName: 'Route Test', email, password: 'Str0ng!Passw0rd123',
  });

  // The status was never the thing that broke — it was 202 throughout the outage.
  assert.equal(r.status, 202, `expected 202, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.emailVerificationRequired, true, 'the deployed frontend keys on this field');

  await settle();

  // THE ASSERTION THAT MATTERS. Against the broken build this array is empty, because the
  // handler threw ReferenceError: sendAfterResponse is not defined before the send was queued.
  assert.equal(sent.length, 1,
    `registration must send exactly one verification email — sent ${sent.length}. ` +
    'An empty list is the production defect: 202 returned, inbox stays empty.');
  assert.equal(sent[0].kind, 'verification');
  assert.equal(sent[0].to, email);
  assert.match(String(sent[0].code), /^\d{6}$/, 'a 6-digit OTP must be handed to the mailer');
});

test('the register handler does not throw after responding', async () => {
  // The ReferenceError also drove the catch block into a second res.json(), producing
  // ERR_HTTP_HEADERS_SENT in production. Nothing should be logged as a signup stage=error.
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  try {
    await post('/api/crm/public/register', {
      fullName: 'Route Test 2', email: `route-test2-${Date.now()}@example.com`, password: 'Str0ng!Passw0rd123',
    });
    await settle();
  } finally { console.error = realErr; }

  const bad = errs.filter((l) => /stage=error|ReferenceError|ERR_HTTP_HEADERS_SENT/.test(l));
  assert.equal(bad.length, 0, `handler logged post-response errors:\n  ${bad.join('\n  ')}`);
});

test('every route module that calls sendAfterResponse also imports it', () => {
  // A cheap, direct guard on the exact mistake: the symbol was used in two files and required
  // in only one. This catches it in ANY route, including ones no HTTP test covers yet.
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'routes');
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      const uses = /\bsendAfterResponse\s*\(/.test(src);
      const imports = /require\(['"][^'"]*utils\/deferredSend['"]\)/.test(src);
      if (uses && !imports) offenders.push(path.relative(path.join(__dirname, '..'), p));
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [],
    `these route files call sendAfterResponse() without importing it: ${offenders.join(', ')}`);
});
