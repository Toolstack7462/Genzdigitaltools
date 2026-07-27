'use strict';
/**
 * The outbound Resend call must fail FAST and STRUCTURED — inside the web server's
 * worker-kill window — on every stall shape.
 *
 * WHY THIS EXISTS (measured in production, twice). When the outbound HTTPS call to
 * api.resend.com stalls, LiteSpeed kills the unresponsive worker and serves its OWN 503 page.
 * That page bypasses Express, so it carries no CORS header and no JSON body: the browser
 * reports a CORS error, axios sees no response, and the UI falls back to a generic
 * "Could not send the email." Signup's own error path is fine — it returns a structured 502,
 * keeps the pending row and does not burn the resend cooldown — but it never gets to run.
 *
 * Two defects let the stall outlive the cap:
 *
 *  1. THE UNCAPPED BODY READ. `fetch` resolves as soon as the response HEADERS arrive; the
 *     body is still streaming. The old code called clearTimeout() right there, so every
 *     `await resp.json()` afterwards ran with NO abort armed. A connection that delivered
 *     headers and then stalled hung indefinitely — observed live as a 504 at 55 seconds.
 *
 *  2. A CAP ABOVE THE KILL WINDOW. Time-to-kill measured live: 3.1s, 5.2s, 5.4s. A 4s cap
 *     loses to the 3.1s case, and any value the operator leaves in EMAIL_TIMEOUT_MS above the
 *     kill window can never produce a structured error at all.
 *
 * These tests use a local stalling server, so they assert the real timing behaviour without
 * touching Resend, the network, or any shared environment.
 *
 * Run: node --test tests/emailTimeoutCap.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abcdef0123456789';
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// ── A server that can stall in either shape ──────────────────────────────────
// mode 'headers'  : never responds at all
// mode 'body'     : sends 200 + headers immediately, then never finishes the body
//                   (this is the shape the old clearTimeout() placement could not cap)
let mode = 'headers';
let server, PORT;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (mode === 'body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":"partial');      // headers + a fragment, then hang forever
      return;                            // never res.end()
    }
    // 'headers': hang before writing anything
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  PORT = server.address().port;
});
test.after(() => { try { server.close(); } catch (_) {} for (const s of sockets) { try { s.destroy(); } catch (_) {} } });

const sockets = [];
test.before(() => { server.on('connection', (s) => sockets.push(s)); });

// Point the mailer at the stalling server by overriding the module's endpoint.
function loadMailerAgainst(port, envTimeout) {
  delete require.cache[require.resolve('../utils/email.js')];
  if (envTimeout === undefined) delete process.env.EMAIL_TIMEOUT_MS;
  else process.env.EMAIL_TIMEOUT_MS = String(envTimeout);
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_FROM = 'Test <noreply@example.com>';
  const src = require('fs').readFileSync(require.resolve('../utils/email.js'), 'utf8')
    .replace("const RESEND_ENDPOINT = 'https://api.resend.com/emails';",
             `const RESEND_ENDPOINT = 'http://127.0.0.1:${port}/emails';`);
  const Module = require('module');
  const m = new Module(require.resolve('../utils/email.js'));
  m.filename = require.resolve('../utils/email.js');
  m.paths = Module._nodeModulePaths(require('path').dirname(m.filename));
  m._compile(src, m.filename);
  return m.exports;
}

async function timeSend(mailer) {
  const t0 = Date.now();
  const r = await mailer.sendEmail({ to: 'x@example.com', subject: 'S', html: '<p>h</p>', text: 't' });
  return { ms: Date.now() - t0, r };
}

test('a stall BEFORE the response headers aborts inside the cap, with a structured code', async () => {
  mode = 'headers';
  const mailer = loadMailerAgainst(PORT, undefined);
  const { ms, r } = await timeSend(mailer);
  assert.equal(r.code, 'EMAIL_TIMEOUT', `expected EMAIL_TIMEOUT, got ${r.code}`);
  assert.ok(r.error, 'a structured error is returned, never a throw');
  assert.ok(ms < 3500, `must abort inside the worker-kill window, took ${ms}ms`);
});

test('a stall AFTER the headers (mid-body) is ALSO capped — the 55s-504 regression', async () => {
  // THE REGRESSION: against the old code this hangs forever. clearTimeout() had already
  // disarmed the abort the moment the headers arrived, so resp.json() ran uncapped — which is
  // the shape of the 55-second 504 seen in production. What this test pins is that it RETURNS
  // PROMPTLY. Hanging is the bug; the classification below is deliberately NOT a failure.
  mode = 'body';
  const mailer = loadMailerAgainst(PORT, undefined);
  const { ms, r } = await timeSend(mailer);
  assert.ok(ms < 3500, `mid-body stall must be capped, took ${ms}ms (old code: never returned)`);

  // …and it must be reported as ACCEPTED, not as a failure. We are past resp.ok, so the 2xx
  // status line IS the provider's acceptance — the body only carries the id. Calling this an
  // error would tell the user we could not send a mail that is already on its way and push
  // them into a duplicate. So: no error code, and messageId simply unknown.
  assert.equal(r.error, undefined, 'an already-accepted send must not be reported as failed');
  assert.equal(r.code, undefined, 'no failure code when the provider already returned 2xx');
  assert.equal(r.messageId, null, 'the id is genuinely unknown — never fabricated');
});

test('the cap is clamped so a stale EMAIL_TIMEOUT_MS cannot reintroduce the opaque 503', async () => {
  mode = 'headers';
  const mailer = loadMailerAgainst(PORT, 30000);   // operator left 30s in the env
  const { ms, r } = await timeSend(mailer);
  assert.equal(r.code, 'EMAIL_TIMEOUT');
  assert.ok(ms < 3500, `a 30s env value must be clamped to the ceiling, took ${ms}ms`);
});

test('a deliberately SHORTER env value is still honoured (clamp is an upper bound only)', async () => {
  mode = 'headers';
  const mailer = loadMailerAgainst(PORT, 800);
  const { ms, r } = await timeSend(mailer);
  assert.equal(r.code, 'EMAIL_TIMEOUT');
  assert.ok(ms < 2000, `800ms should abort well under the ceiling, took ${ms}ms`);
});

test('the failure is a returned value, so signup can answer 502 with CORS rather than dying', async () => {
  mode = 'headers';
  const mailer = loadMailerAgainst(PORT, undefined);
  const { r } = await timeSend(mailer);
  // routes/public.js keys off exactly these fields to build its structured 502.
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'error'));
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'code'));
  assert.ok(r.adminMessage, 'an operator-facing message is always attached');
});
