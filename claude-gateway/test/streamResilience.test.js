'use strict';
/**
 * INTEGRATION — the lifetime of a streamed Claude answer, through the real server.js.
 *
 * THE DEFECT: the gateway guarded every proxied request with a single `upstream.setTimeout(30s)`.
 * That maps onto `socket.setTimeout`, an IDLE timer armed for the whole life of the socket —
 * INCLUDING while the answer was streaming. Claude legitimately goes quiet for longer than that
 * during extended thinking, a tool call or file generation, so the socket was destroyed mid-answer;
 * the teardown path saw headers already sent and called a bare `res.end()`. That is a CLEAN EOF in
 * the middle of an SSE stream — no terminating event, no error — which the client cannot tell apart
 * from a finished answer. Hence "Claude's response was interrupted", a spinner that never resolves,
 * and a file stuck on "Creating file".
 *
 * VERIFIED MEANINGFUL — measured against the pre-fix server.js, 4 of these 5 tests fail:
 *   • "survives a long silent pause"  — FAILS pre-fix at ~1.2s: the socket budget destroys the
 *     stream mid-answer and the body arrives truncated, with no error of any kind.
 *   • "passed through byte-for-byte"  — FAILS pre-fix for the same reason (truncated body).
 *   • "terminates a broken stream"    — FAILS pre-fix by HANGING to the test timeout: no error
 *     frame is ever sent and the response never ends. That hang IS the stuck spinner.
 *   • "background request JSON"       — FAILS pre-fix: it returned text/plain "Upstream error".
 *   • "tears down on client abort"    — PASSES on both. Kept as a forward-looking invariant, NOT
 *     claimed as a regression test: the mock upstream sees its request close when the client
 *     socket goes away regardless of whether the gateway destroys the upstream leg, so this
 *     assertion cannot distinguish the two. The teardown it guards is still worth keeping.
 *
 * Ports 18910/18911 (each gateway test file owns its own — a shared port silently breaks the OTHER
 * file's assertions, not yours).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('node:child_process');

const GW = path.join(__dirname, '..');
const PORT = 18910;
const SECRET = 's'.repeat(48);
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// The pre-response budget is deliberately TINY here. It is what the pre-fix code also applied to
// the streaming body, so a mid-stream pause longer than this is precisely the regression trigger.
const HEADERS_BUDGET_MS = 1000;
const PAUSE_MS = 2600;           // comfortably longer than the budget above

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintLease() {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ jti: 'j' + crypto.randomBytes(6).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

let upstream, backend, gw;
let upstreamClosed = [];   // paths whose upstream request emitted 'close' before finishing

function req(method, p, headers, body) {
  return new Promise((resolve) => {
    const r = http.request({ port: PORT, path: p, method, headers: headers || {} }, (res) => {
      const b = []; res.on('data', (c) => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}

/** Issue a streaming POST and resolve once the response ENDS, capturing timing + raw body. */
function stream(p, cookie, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request({
      port: PORT, path: p, method: 'POST',
      headers: { cookie, 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': DESKTOP },
    }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c.toString('utf8');
        if (o.abortAfterFirstChunk) { try { r.destroy(); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, body, aborted: true, ms: Date.now() - t0 }); }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, aborted: false, ms: Date.now() - t0 }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body, aborted: true, ms: Date.now() - t0 }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '', aborted: true, ms: Date.now() - t0 }));
    r.end(JSON.stringify({ prompt: 'hello' }));
  });
}

async function waitUp() {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await req('GET', '/__genz/health')).status === 200) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('gateway did not boot');
}
async function session() {
  const r = await req('GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': DESKTOP });
  const sc = [].concat(r.headers['set-cookie'] || []).find((c) => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set the session cookie');
  return sc.split(';')[0];
}
const COMPLETION = '/api/organizations/ORG/chat_conversations/CONV/completion';

test.before(async () => {
  upstream = http.createServer((q, r) => {
    let drained = ''; q.on('data', (c) => { drained += c; });
    q.on('end', () => {
      const url = q.url.split('?')[0];
      const mode = (q.url.split('?')[1] || '');

      // A normal streamed answer, with a LONG SILENT PAUSE in the middle — an extended-thinking
      // stretch, a tool call, or a file being written. The whole point: this must survive.
      if (url === COMPLETION && /slow/.test(mode)) {
        r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        r.write('event: message\ndata: {"i":1}\n\n');
        setTimeout(() => {
          if (r.writableEnded) return;
          r.write('event: message\ndata: {"i":2}\n\n');
          r.write('event: message_stop\ndata: {"done":true}\n\n');
          r.end();
        }, PAUSE_MS);
        // Record a client-abort teardown reaching this far.
        q.on('close', () => { if (!r.writableEnded) upstreamClosed.push(url); });
        return;
      }

      // A stream that DIES half way — the upstream connection drops mid-answer.
      if (url === COMPLETION && /die/.test(mode)) {
        r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        r.write('event: message\ndata: {"partial":"half an answer"}\n\n');
        setTimeout(() => { try { r.destroy(); } catch (_) {} }, 120);
        return;
      }

      // A background (non-streaming) call that the upstream never answers properly.
      if (url === '/api/dead') { try { r.destroy(); } catch (_) {} return; }

      if (url === '/new') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<html><head></head><body>app</body></html>'); }
      r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true}');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  backend = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => {
      r.writeHead(200, { 'content-type': 'application/json' });
      if (/\/validate$/.test(q.url)) return r.end(JSON.stringify({ valid: true, expiresAt: new Date(Date.now() + 1800000).toISOString(), serverTime: new Date().toISOString() }));
      if (/\/session$/.test(q.url)) return r.end(JSON.stringify({ ok: true, cookies: [{ name: 'sessionKey', value: 'x' }], accountLabel: 'Account 1' }));
      r.end('{"ok":true}');
    });
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));

  gw = spawn(process.execPath, ['server.js'], {
    cwd: GW, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      PORT: String(PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
      TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
      API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
      CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
      // The pre-response budget only. Pre-fix this ALSO governed the streaming body.
      UPSTREAM_TIMEOUT_MS: String(HEADERS_BUDGET_MS),
    }),
  });
  await waitUp();
});

test.after(() => {
  try { gw.kill(); } catch (_) {}
  try { upstream.close(); } catch (_) {}
  try { backend.close(); } catch (_) {}
});

// ── THE core regression ─────────────────────────────────────────────────────
test('a long answer SURVIVES a silent pause far longer than the pre-response budget', async () => {
  const cookie = await session();
  const r = await stream(COMPLETION + '?slow', cookie);

  assert.strictEqual(r.status, 200);
  assert.ok(r.ms > PAUSE_MS, 'the pause really happened (' + r.ms + 'ms)');
  // Every chunk, including the ones AFTER the pause, must arrive.
  assert.match(r.body, /"i":1/, 'the pre-pause chunk');
  assert.match(r.body, /"i":2/, 'THE REGRESSION: the post-pause chunk must not be cut off');
  assert.match(r.body, /message_stop/, 'the answer is terminated normally by the upstream');
  // A healthy stream must NOT carry a fabricated error.
  assert.ok(!/event: error/.test(r.body), 'no error frame is invented on a successful answer');
});

test('a healthy stream is passed through byte-for-byte, not buffered or rewritten', async () => {
  const cookie = await session();
  const r = await stream(COMPLETION + '?slow', cookie);
  assert.match(r.headers['content-type'] || '', /text\/event-stream/);
  assert.ok(!r.headers['content-encoding'], 'SSE is never compressed — that would stall token-by-token delivery');
  assert.strictEqual(
    r.body,
    'event: message\ndata: {"i":1}\n\nevent: message\ndata: {"i":2}\n\nevent: message_stop\ndata: {"done":true}\n\n',
    'the stream reaches the browser exactly as the upstream wrote it'
  );
});

// ── A broken stream must SAY so ─────────────────────────────────────────────
test('a stream that dies mid-answer is TERMINATED with a retryable error frame', async () => {
  const cookie = await session();
  const r = await stream(COMPLETION + '?die', cookie);

  // The partial answer is preserved — the user keeps what Claude had already produced.
  assert.match(r.body, /half an answer/, 'partial content is preserved');
  // THE REGRESSION: pre-fix this was a bare res.end() — a clean EOF the client renders as a
  // finished answer, leaving the spinner (or "Creating file") stuck forever.
  assert.match(r.body, /event: error/, 'the stream is closed with an explicit error event');

  const frame = r.body.slice(r.body.lastIndexOf('event: error'));
  const payload = JSON.parse(frame.slice(frame.indexOf('data: ') + 6).trim());
  assert.strictEqual(payload.type, 'error');
  assert.strictEqual(payload.error.retryable, true, 'a dropped connection is retryable, never a dead session');
  assert.ok(payload.error.message.length > 10, 'exactly one human-readable sentence');
  assert.ok(!/session (has )?ended|reconnect|contact support/i.test(r.body), 'a transient stream fault is NOT an account problem');

  // Exactly ONE error frame — the user must not see the failure reported twice.
  assert.strictEqual(r.body.split('event: error').length - 1, 1, 'one error message only');
});

// ── Client disconnect must tear the upstream leg down ───────────────────────
test('a client that goes away tears down the upstream request promptly', async () => {
  const cookie = await session();
  upstreamClosed = [];
  const r = await stream(COMPLETION + '?slow', cookie, { abortAfterFirstChunk: true });
  assert.ok(r.aborted, 'the client hung up mid-stream');

  // NOTE: this assertion passes against the pre-fix build too (the mock sees its request close
  // when the client socket goes away, whether or not the gateway destroyed the upstream leg), so
  // it is a forward-looking invariant rather than a regression test. The explicit teardown it
  // guards still matters: without it claude.ai keeps streaming into a dead response and holds a
  // keep-alive pool slot until the idle budget expires.
  await new Promise((res) => setTimeout(res, 800));
  assert.ok(upstreamClosed.length >= 1, 'the upstream request was closed, not left streaming into a dead response');
});

// ── Background failures stay machine-readable ───────────────────────────────
test('a failed BACKGROUND request returns structured JSON, never an HTML page', async () => {
  const cookie = await session();
  const r = await req('GET', '/api/dead', { cookie, accept: 'application/json', 'user-agent': DESKTOP });

  assert.match(r.headers['content-type'] || '', /application\/json/, 'JSON, so the SPA cannot treat it as a page to navigate to');
  assert.ok(!/<html|<!doctype/i.test(r.body), 'never an HTML document');
  const b = JSON.parse(r.body);
  assert.ok(b.code, 'carries a structured code');
  assert.strictEqual(b.retryable, true, 'a transient upstream failure is retryable');
  assert.strictEqual(b.terminal, false, 'and is never terminal — it must not end a session');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
});
