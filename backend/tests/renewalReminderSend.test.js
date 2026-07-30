'use strict';
/**
 * Email-transport + renewal-send regression suite.
 *   node --test backend/tests/renewalReminderSend.test.js
 *
 * Drives the REAL utils/email.js by stubbing global fetch, so every provider
 * outcome (auth failure, rate limit, rejection, timeout, outage, success) is
 * exercised without touching the network or sending mail.
 *
 * These are the cases behind the admin "Could not send the email." toast: each
 * one must now produce a STRUCTURED code plus an admin-safe sentence, and must
 * never leak the API key or the message body.
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const email = require('../utils/email');
const { withLock } = require('../utils/keyedLock');

const { EMAIL_CODES, classifyStatus, adminMessageFor, sendEmail } = email;
const API_KEY = 're_test_SECRET_KEY_do_not_leak';

const realFetch = globalThis.fetch;
const realEnv = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };

beforeEach(() => {
  process.env.RESEND_API_KEY = API_KEY;
  process.env.EMAIL_FROM = 'Gen Z Digital Store <noreply@genzdigitalstore.com>';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnv.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = realEnv.key;
  if (realEnv.from === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = realEnv.from;
});

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const send = () => sendEmail({ to: 'admin@example.com', subject: 'Renewal reminder', html: '<p>hi</p>', text: 'hi' });

// ── 11. success path ────────────────────────────────────────────────────────
test('11. a successful send returns the provider message id (proof of acceptance)', async () => {
  globalThis.fetch = async () => jsonResponse(200, { id: 'msg_abc123' });
  const r = await send();
  assert.equal(r.error, undefined);
  assert.equal(r.messageId, 'msg_abc123');
  assert.equal(r.id, 'msg_abc123');
});

// ── 12. SMTP/provider authentication failure ────────────────────────────────
test('12. a 401 from the provider is EMAIL_AUTH_FAILED with an actionable message', async () => {
  globalThis.fetch = async () => jsonResponse(401, { name: 'validation_error', message: 'API key is invalid' });
  const r = await send();
  assert.equal(r.code, EMAIL_CODES.AUTH_FAILED);
  assert.equal(r.code, 'EMAIL_AUTH_FAILED');
  assert.match(r.adminMessage, /API key/i);
});

test('12b. an unverified sending domain (403) gets its OWN code, not the auth one', async () => {
  // These used to share SMTP_AUTH_FAILED. They are different operator actions — rotate a key
  // vs fix DNS at the provider — and merging them is what sent the last outage's debugging
  // toward the credentials when the credentials were fine.
  globalThis.fetch = async () => jsonResponse(403, { message: 'The genzdigitalstore.com domain is not verified' });
  const r = await send();
  assert.equal(r.code, EMAIL_CODES.DOMAIN_UNVERIFIED);
  assert.notEqual(r.code, EMAIL_CODES.AUTH_FAILED, 'a DNS problem must not read as a bad key');
  assert.match(r.adminMessage, /domain/i, 'and the admin is pointed at the domain, not the key');
  assert.equal(r.domainNotVerified, true, 'flagged so the admin is told to verify the domain');
});

// ── 13. timeout + provider outage, and recovery afterwards ──────────────────
test('13. a provider timeout is EMAIL_TIMEOUT and never hangs the request', async () => {
  globalThis.fetch = async (_url, opts) => {
    // Mimic undici: reject with AbortError once the caller's signal fires.
    return new Promise((_resolve, reject) => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(err), { once: true });
    });
  };
  const started = Date.now();
  const r = await sendEmail({ to: 'admin@example.com', subject: 'x', text: 'x' });
  assert.equal(r.code, EMAIL_CODES.TIMEOUT);
  assert.equal(r.code, 'EMAIL_TIMEOUT');
  assert.ok(Date.now() - started < 15000, 'the abort cap bounds the request');
});

test('13b. a provider outage is EMAIL_PROVIDER_UNAVAILABLE, and the next send recovers', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED api.resend.com'); };
  const bad = await send();
  assert.equal(bad.code, EMAIL_CODES.CONNECTION_FAILED);
  assert.equal(bad.code, 'EMAIL_PROVIDER_UNAVAILABLE');

  globalThis.fetch = async () => jsonResponse(200, { id: 'msg_after_recovery' });
  const good = await send();
  assert.equal(good.messageId, 'msg_after_recovery', 'transport recovers with no reset needed');
});

test('13c. a provider 5xx is a connection/outage fault, a 429 is rate limiting', async () => {
  globalThis.fetch = async () => jsonResponse(503, { message: 'upstream unavailable' });
  assert.equal((await send()).code, EMAIL_CODES.CONNECTION_FAILED);

  globalThis.fetch = async () => jsonResponse(429, { message: 'Too many requests' });
  const limited = await send();
  assert.equal(limited.code, EMAIL_CODES.RATE_LIMITED);
  assert.match(limited.adminMessage, /rate-limiting/i);
});

test('13d. a refused recipient/message is EMAIL_REJECTED, not an outage', async () => {
  globalThis.fetch = async () => jsonResponse(422, { name: 'validation_error', message: 'Invalid `to` field' });
  const r = await send();
  assert.equal(r.code, EMAIL_CODES.REJECTED);
});

// ── 14. duplicate-send protection ───────────────────────────────────────────
test('14. the per-client send lock serialises rapid double-clicks', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let sends = 0;
  const clickSend = () => withLock('renewal-email:client-1', async () => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 10));
    sends++;
    concurrent--;
  });

  await Promise.all([clickSend(), clickSend(), clickSend()]);
  assert.equal(maxConcurrent, 1, 'never two sends in flight for one client');
  assert.equal(sends, 3, 'each queued call still runs (dedupe is a separate check)');
});

test('14b. different clients are not blocked by each other', async () => {
  const order = [];
  await Promise.all([
    withLock('renewal-email:a', async () => { await new Promise(r => setTimeout(r, 20)); order.push('a'); }),
    withLock('renewal-email:b', async () => { order.push('b'); }),
  ]);
  assert.deepEqual(order, ['b', 'a'], 'client b did not wait behind client a');
});

// ── validation + secret-safety ──────────────────────────────────────────────
test('an invalid recipient is rejected before the provider is called', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse(200, { id: 'x' }); };
  const r = await sendEmail({ to: 'not-an-email', subject: 'x', text: 'x' });
  assert.equal(r.code, EMAIL_CODES.INVALID_RECIPIENT);
  assert.equal(called, false, 'no wasted provider call');
});

test('a template with no body is TEMPLATE_ERROR', async () => {
  const r = await sendEmail({ to: 'admin@example.com', subject: 'x' });
  assert.equal(r.code, EMAIL_CODES.TEMPLATE_ERROR);
});

test('missing configuration is reported as skipped + EMAIL_CONFIG_MISSING', async () => {
  delete process.env.RESEND_API_KEY;
  const r = await send();
  assert.equal(r.skipped, true);
  assert.equal(r.code, EMAIL_CODES.NOT_CONFIGURED);
});

test('SECURITY: no failure path ever returns the API key or the message body', async () => {
  const bodies = [
    () => jsonResponse(401, { message: 'API key is invalid' }),
    () => jsonResponse(429, { message: 'slow down' }),
    () => jsonResponse(500, { message: 'boom' }),
  ];
  for (const make of bodies) {
    globalThis.fetch = async () => make();
    const serialized = JSON.stringify(await send());
    assert.ok(!serialized.includes(API_KEY), 'API key never surfaces');
    assert.ok(!serialized.includes('<p>hi</p>'), 'message body never surfaces');
  }
});

test('classifyStatus maps every status onto a stable, documented code', () => {
  assert.equal(classifyStatus(401), 'EMAIL_AUTH_FAILED');
  // A 403 naming an unverified domain is now its OWN code: the operator fixes DNS at the
  // provider, not the API key, and collapsing the two sent the last debug in the wrong direction.
  assert.equal(classifyStatus(403, 'domain is not verified'), 'EMAIL_DOMAIN_UNVERIFIED');
  assert.equal(classifyStatus(403, 'forbidden'), 'EMAIL_REJECTED');
  assert.equal(classifyStatus(422), 'EMAIL_REJECTED');
  assert.equal(classifyStatus(429), 'EMAIL_RATE_LIMITED');
  assert.equal(classifyStatus(502), 'EMAIL_PROVIDER_UNAVAILABLE');
  assert.equal(classifyStatus(422, 'recipient is on the suppression list'), 'EMAIL_SUPPRESSED');
  assert.equal(classifyStatus(418), 'EMAIL_SEND_FAILED');
  for (const code of Object.values(EMAIL_CODES)) {
    assert.ok(adminMessageFor(code).length > 10, `${code} has an admin-safe message`);
  }
});
