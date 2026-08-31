'use strict';
/**
 * StealthWriter gateway — a credit is charged ONLY when the upstream response proves a
 * result was produced.
 *   node --test test/usageLifecycle.test.js
 *
 * WHAT THIS PINS
 * The overlay used to call /__genz/consume and only THEN dispatch the humanize request, so
 * StealthWriter answering "the service is temporarily unavailable due to high demand" still
 * cost the member a Humanizer credit. The gateway now reserves first and decides the outcome
 * itself, from the real response: commit on proof of a result, cancel on anything else.
 *
 * Real gateway process, mock backend, programmable mock upstream. Every case asserts the
 * SETTLE the gateway sent (commit vs cancel) — the thing that moves the member's count.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('node:child_process');

const GW = path.resolve(__dirname, '..');
const SECRET = 'x'.repeat(48);
const GATEWAY_KEY = 'k'.repeat(32);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mintLease(extra) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(Object.assign({
    jti: 'j' + crypto.randomBytes(4).toString('hex'), sub: 'u1', scid: 'sc1',
    type: 'stealth_lease', fixed: false, exp: Math.floor(Date.now() / 1000) + 1800,
  }, extra || {}));
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

let upstream, backend, gw, PORT;
const codes = new Map();
// Programmable upstream behaviour for the NEXT proxied request.
let plan = null;
let upstreamRequests = [];
let settles = [];          // every /usage/commit and /usage/cancel the gateway sent
let reserveCalls = [];
let backendDown = false;   // simulate the backend refusing to answer
let gwOutput = '';         // everything the gateway process logged
let commitFailures = 0;    // number of 5xx answers to give /usage/commit before succeeding

function request(method, p, headers, body) {
  return new Promise((resolve) => {
    const buf = body === undefined ? null : Buffer.from(body);
    const h = Object.assign({}, headers || {});
    if (buf) h['content-length'] = buf.length;
    const r = http.request({ port: PORT, path: p, method, headers: h }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (buf) r.write(buf);
    r.end();
  });
}
const postForm = (p, fields, headers) =>
  request('POST', p, Object.assign({ 'content-type': 'application/x-www-form-urlencoded' }, headers || {}),
    new URLSearchParams(fields).toString());
const postJson = (p, obj, headers) =>
  request('POST', p, Object.assign({ 'content-type': 'application/json' }, headers || {}), JSON.stringify(obj || {}));

function issueCode(leaseExtra) {
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, { lease: mintLease(leaseExtra) });
  return code;
}
const sessionCookieFrom = (res) =>
  [].concat(res.headers['set-cookie'] || []).find(c => /^__Host-stealth_session=/.test(c)) || null;
const cookieValue = (setCookie) => setCookie.split(';')[0];

async function openSession() {
  const res = await postForm('/launch', { code: issueCode() });
  return cookieValue(sessionCookieFrom(res));
}

const OP = () => crypto.randomBytes(16).toString('hex');

/** Drive one metered upstream request through the gateway, exactly as a tagged fetch would. */
function metered(cookie, op, action, p) {
  return postJson(p || '/api/humanize', { hello: 'world' }, {
    cookie,
    'x-genz-op': op,
    'x-genz-action': action || 'humanizer',
  });
}

/** Wait until the gateway has settled `op`, or time out. */
async function settleOf(op, timeoutMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = settles.filter(s => s.operationId === op);
    if (hit.length) return hit;
    await new Promise(r => setTimeout(r, 40));
  }
  return [];
}
/** Give the gateway a moment and assert it settled NOTHING for `op`. */
async function noSettleFor(op, waitMs = 900) {
  await new Promise(r => setTimeout(r, waitMs));
  return settles.filter(s => s.operationId === op);
}

test.before(async () => {
  upstream = http.createServer((q, r) => {
    const chunks = [];
    q.on('data', c => chunks.push(c));
    q.on('end', () => {
      upstreamRequests.push({ url: q.url, method: q.method, headers: q.headers });
      const p = plan || { status: 200, ct: 'text/html', body: '<html><head></head><body>STEALTH_APP_OK</body></html>' };
      if (p.destroy) { q.socket.destroy(); return; }             // network failure
      if (p.hang) { return; }                                     // never answers
      r.writeHead(p.status, { 'content-type': p.ct });
      r.end(p.body === undefined ? '' : p.body);
    });
  });
  await new Promise(r => upstream.listen(0, r));

  backend = http.createServer((q, r) => {
    let body = '';
    q.on('data', c => { body += c; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch (_) {}

      if (backendDown && /\/usage\//.test(q.url)) { q.socket.destroy(); return; }

      if (q.url.endsWith('/redeem-launch')) {
        const rec = codes.get(parsed.code);
        if (!rec) { r.statusCode = 400; return r.end(JSON.stringify({ ok: false, code: 'launch_code_invalid' })); }
        codes.delete(parsed.code);
        return r.end(JSON.stringify({ ok: true, lease: rec.lease, capture: false, fixedLease: false, secondsRemaining: 1800 }));
      }
      if (q.url.endsWith('/validate')) {
        return r.end(JSON.stringify({
          valid: true, terminal: false, retryable: false, secondsRemaining: 1800,
          plan: { planName: 'Pro', limits: { humanizer: 50, detector: 20 }, used: { humanizer: 3, detector: 1 }, remaining: { humanizer: 47, detector: 19 } },
          resetLabel: '5:00 AM Pakistan Time',
        }));
      }
      if (q.url.endsWith('/usage/reserve')) {
        reserveCalls.push({ headers: q.headers, body: parsed });
        return r.end(JSON.stringify({ ok: true, allowed: true, code: 'ok', action: parsed.action, operationId: OP(), remaining: { humanizer: 47, detector: 19 } }));
      }
      if (q.url.endsWith('/usage/commit')) {
        settles.push({ kind: 'commit', headers: q.headers, ...parsed });
        if (commitFailures > 0) { commitFailures--; r.statusCode = 503; return r.end(JSON.stringify({ ok: false, code: 'server_error' })); }
        return r.end(JSON.stringify({ ok: true, committed: true, code: 'ok', remaining: { humanizer: 46, detector: 19 } }));
      }
      if (q.url.endsWith('/usage/cancel')) {
        settles.push({ kind: 'cancel', headers: q.headers, ...parsed });
        return r.end(JSON.stringify({ ok: true, cancelled: true, code: 'ok', remaining: { humanizer: 47, detector: 19 } }));
      }
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', label: 'a***1' }, bundle: { cookies: [{ name: 'sw_session', value: 'VAULT' }] } }));
      r.end('{}');
    });
  });
  await new Promise(r => backend.listen(0, r));

  PORT = 18897;
  gw = spawn(process.execPath, ['server.js'], {
    cwd: GW,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      STEALTH_TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      STEALTH_API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT,
      STEALTH_LEASE_SECRET: SECRET, STEALTH_GATEWAY_KEY: GATEWAY_KEY,
      STEALTH_DEFAULT_PATH: '/dashboard/humanizer', STEALTH_SIGNIN_PATH: '/sign-in',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gw.stdout.on('data', c => { gwOutput += c; });
  gw.stderr.on('data', c => { gwOutput += c; });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const r = await postForm('/launch', {});
    if (r.status !== 0) break;
    await new Promise(x => setTimeout(x, 150));
  }
});
test.after(() => {
  try { gw.kill(); } catch (_) {}
  try { upstream.close(); } catch (_) {}
  try { backend.close(); } catch (_) {}
});
test.beforeEach(() => {
  plan = null; upstreamRequests = []; settles = []; reserveCalls = [];
  backendDown = false; commitFailures = 0;
});

// ── The successful outcome ──────────────────────────────────────────────────────────────

test('a real result commits exactly once', async () => {
  const cookie = await openSession();
  const op = OP();
  // The audited StealthWriter success shape: an obfuscated {d,s} envelope. Never decoded.
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ d: 'QUJDREVG', s: 'k3y' }) };

  const res = await metered(cookie, op, 'humanizer');
  assert.equal(res.status, 200, 'the member still gets the real response');

  const hits = await settleOf(op);
  assert.equal(hits.length, 1, 'exactly one settle — no duplicate charge');
  assert.equal(hits[0].kind, 'commit');
  assert.equal(hits[0].action, 'humanizer');
  assert.equal(hits[0].upstreamStatus, 200);
  assert.equal(hits[0].headers['x-gateway-key'], GATEWAY_KEY, 'commit is gateway-authenticated');
  assert.equal(upstreamRequests.length, 1, 'one upstream POST, no retry loop');
});

test('a plain (unencoded) result field also commits', async () => {
  const cookie = await openSession();
  const op = OP();
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ result: 'a humanized paragraph' }) };
  await metered(cookie, op, 'humanizer');
  const hits = await settleOf(op);
  assert.equal(hits[0].kind, 'commit');
});

test('an AI Detector result commits against the detector action only', async () => {
  const cookie = await openSession();
  const op = OP();
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ d: 'QUJD', s: 'k3y' }) };
  await metered(cookie, op, 'detector', '/api/scan');
  const hits = await settleOf(op);
  assert.equal(hits[0].kind, 'commit');
  assert.equal(hits[0].action, 'detector');
});

// ── Every no-charge outcome ─────────────────────────────────────────────────────────────

const NO_CHARGE = [
  ['high demand 503', { status: 503, ct: 'application/json', body: JSON.stringify({ error: 'The service is temporarily unavailable due to high demand.' }) }],
  ['rate limited 429', { status: 429, ct: 'application/json', body: JSON.stringify({ error: 'Too many requests' }) }],
  ['request timeout 408', { status: 408, ct: 'application/json', body: '{}' }],
  ['too early 425', { status: 425, ct: 'application/json', body: '{}' }],
  ['bad request 400', { status: 400, ct: 'application/json', body: JSON.stringify({ error: 'bad input' }) }],
  ['upstream 500', { status: 500, ct: 'application/json', body: '{}' }],
  ['bad gateway 502', { status: 502, ct: 'text/plain', body: 'Bad Gateway' }],
  ['HTTP 200 with an error payload', { status: 200, ct: 'application/json', body: JSON.stringify({ error: 'The service is temporarily unavailable due to high demand.' }) }],
  ['HTTP 200 with success:false', { status: 200, ct: 'application/json', body: JSON.stringify({ success: false, message: 'nope' }) }],
  ['empty 200', { status: 200, ct: 'application/json', body: '' }],
  ['malformed 200', { status: 200, ct: 'application/json', body: '{"d":' }],
  ['200 with no result field', { status: 200, ct: 'application/json', body: JSON.stringify({ ok: true, meta: {} }) }],
  ['job accepted but no result yet', { status: 202, ct: 'application/json', body: JSON.stringify({ jobId: 'abc', status: 'queued' }) }],
  ['job accepted (200) that only acknowledges', { status: 200, ct: 'application/json', body: JSON.stringify({ jobId: 'abc', status: 'processing' }) }],
  ['an unaudited RSC / server-action response', { status: 200, ct: 'text/x-component', body: '0:{"a":1}\n' }],
];

for (const [name, upstreamPlan] of NO_CHARGE) {
  test(`${name} → cancelled, the count never moves`, async () => {
    const cookie = await openSession();
    const op = OP();
    plan = upstreamPlan;
    await metered(cookie, op, 'humanizer');
    const hits = await settleOf(op);
    assert.equal(hits.length, 1, 'settled exactly once');
    assert.equal(hits[0].kind, 'cancel', `${name} must not charge`);
  });
}

test('a network failure to the upstream cancels', async () => {
  const cookie = await openSession();
  const op = OP();
  plan = { destroy: true };
  await metered(cookie, op, 'humanizer');
  const hits = await settleOf(op);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'cancel');
  assert.equal(hits[0].outcomeCode, 'upstream_transport');
});

test('the browser going away mid-request cancels — page closed during a failed request', async () => {
  const cookie = await openSession();
  const op = OP();
  plan = { hang: true };
  await new Promise((resolve) => {
    const body = Buffer.from('{}');
    const r = http.request({
      port: PORT, path: '/api/humanize', method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'content-length': body.length, 'x-genz-op': op, 'x-genz-action': 'humanizer' },
    });
    r.on('error', () => {});
    r.end(body);
    setTimeout(() => { r.destroy(); resolve(); }, 250);
  });
  const hits = await settleOf(op);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'cancel');
  assert.equal(hits[0].outcomeCode, 'client_aborted');
});

test('a job that is accepted and later succeeds charges once — on the RESULT response', async () => {
  const cookie = await openSession();
  const accepted = OP();
  plan = { status: 202, ct: 'application/json', body: JSON.stringify({ jobId: 'j1', status: 'queued' }) };
  await metered(cookie, accepted, 'humanizer');
  assert.equal((await settleOf(accepted))[0].kind, 'cancel', 'acceptance alone is never a charge');

  const finished = OP();
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ d: 'UkVTVUxU', s: 'k3y' }) };
  await metered(cookie, finished, 'humanizer');
  assert.equal((await settleOf(finished))[0].kind, 'commit');
});

// ── The browser is never trusted ────────────────────────────────────────────────────────

test('a browser cannot commit — /__genz/usage/commit is refused, never proxied', async () => {
  const cookie = await openSession();
  const before = upstreamRequests.length;
  const res = await postJson('/__genz/usage/commit', { action: 'humanizer', operationId: OP() }, { cookie });
  assert.equal(res.status, 403);
  assert.match(res.body, /gateway_decides_outcome/);
  assert.equal(upstreamRequests.length, before, 'and it never reaches StealthWriter');
  assert.equal(settles.length, 0, 'no charge of any kind');
});

test('internal metering headers never reach StealthWriter', async () => {
  const cookie = await openSession();
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ d: 'QQ', s: 'k' }) };
  await metered(cookie, OP(), 'humanizer');
  const sent = upstreamRequests[0].headers;
  for (const k of Object.keys(sent)) {
    assert.ok(!/^x-genz-/i.test(k), 'no X-Genz-* header is forwarded: ' + k);
  }
});

test('an unknown X-Genz-* header is stripped too, even with no operation bound', async () => {
  const cookie = await openSession();
  plan = { status: 200, ct: 'application/json', body: '{}' };
  await postJson('/api/whatever', {}, { cookie, 'x-genz-smuggle': 'nope' });
  const sent = upstreamRequests[0].headers;
  assert.ok(!Object.keys(sent).some(k => /^x-genz-/i.test(k)));
});

test('a malformed operation header meters nothing and still proxies normally', async () => {
  const cookie = await openSession();
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ d: 'QQ', s: 'k' }) };
  const res = await postJson('/api/humanize', {}, { cookie, 'x-genz-op': 'not-hex', 'x-genz-action': 'humanizer' });
  assert.equal(res.status, 200);
  assert.equal((await noSettleFor('not-hex')).length, 0);
  assert.equal(settles.length, 0, 'an unbindable id can never become a charge');
});

test('an unknown action in the header meters nothing', async () => {
  const cookie = await openSession();
  const op = OP();
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ d: 'QQ', s: 'k' }) };
  await metered(cookie, op, 'summarizer');
  assert.equal((await noSettleFor(op)).length, 0);
});

// ── The reserve relay ───────────────────────────────────────────────────────────────────

test('/__genz/usage/reserve relays with the gateway key and the session lease', async () => {
  const cookie = await openSession();
  const res = await postJson('/__genz/usage/reserve', { action: 'humanizer' }, { cookie });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.allowed, true);
  assert.match(body.operationId, /^[0-9a-f]{32}$/);
  assert.equal(reserveCalls.length, 1);
  assert.equal(reserveCalls[0].headers['x-gateway-key'], GATEWAY_KEY);
  assert.match(String(reserveCalls[0].headers.authorization || ''), /^Bearer /);
  assert.equal(reserveCalls[0].body.action, 'humanizer');
});

test('reserve FAILS CLOSED when the backend is unreachable', async () => {
  const cookie = await openSession();
  backendDown = true;
  const res = await postJson('/__genz/usage/reserve', { action: 'humanizer' }, { cookie });
  const body = JSON.parse(res.body);
  assert.equal(body.allowed, false, 'no reservation, so the overlay must not dispatch');
  assert.equal(body.terminal, false, 'and it must never read as an ended session');
  assert.equal(body.retryable, true);
  assert.equal(body.code, 'backend_unavailable');
});

test('a browser-side cancel is relayed and can only ever release', async () => {
  const cookie = await openSession();
  const op = OP();
  const res = await postJson('/__genz/usage/cancel', { action: 'humanizer', operationId: op }, { cookie });
  assert.equal(res.status, 200);
  const hit = settles.find(s => s.operationId === op);
  assert.equal(hit.kind, 'cancel');
  assert.equal(hit.outcomeCode, 'client_cancelled');
});

test('the usage endpoints require a session — no lease, no metering', async () => {
  const res = await postJson('/__genz/usage/reserve', { action: 'humanizer' }, {});
  assert.equal(res.status, 403, 'answered with the block page, never proxied');
  assert.equal(reserveCalls.length, 0);
});

test('GET on a usage endpoint is refused, not proxied to StealthWriter', async () => {
  const cookie = await openSession();
  const before = upstreamRequests.length;
  const res = await request('GET', '/__genz/usage/reserve', { cookie });
  assert.equal(res.status, 405);
  assert.equal(upstreamRequests.length, before);
});

// ── Commit durability ───────────────────────────────────────────────────────────────────

test('a commit the backend fails to answer is retried with the SAME operation id', async () => {
  const cookie = await openSession();
  const op = OP();
  commitFailures = 2; // two 503s, then success
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ d: 'UkVT', s: 'k' }) };
  await metered(cookie, op, 'humanizer');

  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (settles.filter(s => s.operationId === op).length >= 3) break;
    await new Promise(r => setTimeout(r, 60));
  }
  const hits = settles.filter(s => s.operationId === op);
  assert.ok(hits.length >= 3, 'retried after the transient failures');
  assert.ok(hits.every(h => h.kind === 'commit'), 'never flips to a cancel mid-retry');
  assert.equal(new Set(hits.map(h => h.operationId)).size, 1, 'same operation id — the backend dedupes it');
});

test('a settle the backend never accepts stops after a bounded number of attempts', async () => {
  const cookie = await openSession();
  const op = OP();
  commitFailures = 99;
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ d: 'UkVT', s: 'k' }) };
  await metered(cookie, op, 'humanizer');
  await new Promise(r => setTimeout(r, 20000));
  const hits = settles.filter(s => s.operationId === op);
  assert.ok(hits.length <= 5, 'bounded — it does not retry forever (got ' + hits.length + ')');
  assert.ok(hits.length >= 2, 'but it did retry');
});


// ── Log redaction ───────────────────────────────────────────────────────────────────────

test('neither the submitted text nor the generated result is ever logged', async () => {
  const cookie = await openSession();
  const SUBMITTED = 'GENZ_SUBMITTED_TEXT_MARKER_' + crypto.randomBytes(4).toString('hex');
  const PRODUCED = 'GENZ_RESULT_TEXT_MARKER_' + crypto.randomBytes(4).toString('hex');
  const op = OP();
  gwOutput = '';
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ result: PRODUCED, d: 'UkVT', s: 'k' }) };

  await postJson('/api/humanize', { text: SUBMITTED }, { cookie, 'x-genz-op': op, 'x-genz-action': 'humanizer' });
  await settleOf(op);
  await new Promise(r => setTimeout(r, 250));

  assert.ok(!gwOutput.includes(SUBMITTED), 'the submitted text never reaches a log line');
  assert.ok(!gwOutput.includes(PRODUCED), 'neither does the generated result');
  assert.ok(!/__Host-stealth_session|sw_lease|VAULT|Bearer eyJ/.test(gwOutput), 'no session, cookie or lease material either');
  assert.ok(/usage_commit/.test(gwOutput), 'but the outcome itself IS audited');
});

test('an ambiguous outcome logs the response SHAPE only — key names, never values', async () => {
  const cookie = await openSession();
  const SECRETISH = 'GENZ_VALUE_MARKER_' + crypto.randomBytes(4).toString('hex');
  const op = OP();
  gwOutput = '';
  plan = { status: 200, ct: 'application/json', body: JSON.stringify({ metaInfo: SECRETISH, other: [SECRETISH] }) };

  await metered(cookie, op, 'humanizer');
  await settleOf(op);
  await new Promise(r => setTimeout(r, 250));

  assert.ok(/usage_outcome_ambiguous/.test(gwOutput), 'the operator gets the audit warning');
  assert.ok(/metaInfo/.test(gwOutput), 'with the key NAMES, which is what tightens the classifier');
  assert.ok(!gwOutput.includes(SECRETISH), 'and never a value');
});

// ── Nothing else changed ────────────────────────────────────────────────────────────────

test('an ordinary page load still works and is never metered', async () => {
  const cookie = await openSession();
  plan = null; // default HTML app response
  const res = await request('GET', '/dashboard/humanizer', { cookie, accept: 'text/html' });
  assert.equal(res.status, 200);
  assert.match(res.body, /STEALTH_APP_OK/);
  assert.equal(settles.length, 0);
});

test('the legacy /__genz/consume relay still answers for older cached overlays', async () => {
  const cookie = await openSession();
  const res = await postJson('/__genz/consume', { action: 'humanizer' }, { cookie });
  assert.equal(res.status, 200, 'an overlay cached from before this deploy keeps metering');
});

test('an untagged mutating request is proxied unchanged (no backstop configured)', async () => {
  const cookie = await openSession();
  plan = { status: 200, ct: 'application/json', body: '{"ok":true}' };
  const res = await postJson('/api/humanize', {}, { cookie });
  assert.equal(res.status, 200);
  assert.equal(settles.length, 0);
});
