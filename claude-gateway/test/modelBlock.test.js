'use strict';
/**
 * Fable 5 disable — END-TO-END through a real gateway process (claude-only).
 *
 * The unit tests in lib/modelPolicy.test.js prove the policy; this proves the WIRING: that a
 * request actually leaving the browser is rewritten before it reaches upstream, that the model
 * list actually arrives at the browser without Fable 5, and that flipping the admin setting
 * genuinely restores the original behaviour. The upstream stub records exactly what it received,
 * so "the block cannot be bypassed" is asserted against real bytes on the wire.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('node:child_process');

const GW = path.resolve(__dirname, '..');
const SECRET = 'x'.repeat(48);
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintLease() {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ jti: 'j' + crypto.randomBytes(6).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

let upstream, backend;
let received = [];   // every body the upstream actually saw

function req(port, method, p, headers, body) {
  return new Promise((resolve) => {
    const r = http.request({ port, path: p, method, headers: headers || {} }, (res) => {
      const b = []; res.on('data', c => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}

/** Boot a gateway with the admin setting in a given state. */
function boot(port, allowFable5) {
  const env = Object.assign({}, process.env, {
    PORT: String(port), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
    LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
  });
  if (allowFable5) env.CLAUDE_ALLOW_FABLE5 = '1'; else delete env.CLAUDE_ALLOW_FABLE5;
  return spawn(process.execPath, ['server.js'], { cwd: GW, env, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function waitUp(port) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await req(port, 'GET', '/__genz/health')).status === 200) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('gateway ' + port + ' did not boot');
}
async function session(port, ua) {
  const r = await req(port, 'GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': ua || DESKTOP });
  const sc = [].concat(r.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set the session cookie');
  return sc.split(';')[0];
}
const send = (port, cookie, obj, ua) => req(port, 'POST',
  '/api/organizations/ORG/chat_conversations/CONV/completion',
  { cookie, 'content-type': 'application/json', 'user-agent': ua || DESKTOP }, JSON.stringify(obj));

test.before(async () => {
  upstream = http.createServer((q, r) => {
    let b = ''; q.on('data', c => b += c);
    q.on('end', () => {
      if (q.method === 'POST') { try { received.push(JSON.parse(b)); } catch (_) { received.push({ raw: b }); } }
      // The model list the picker renders.
      if (q.url.indexOf('/api/models') === 0) {
        r.writeHead(200, { 'content-type': 'application/json' });
        return r.end(JSON.stringify({ models: [
          { id: 'claude-opus-4-8', name: 'Opus 4.8' },
          { id: 'claude-fable-5', name: 'Fable 5' },
          { id: 'claude-sonnet-5', name: 'Sonnet 5' },
        ], auto_model_selection: true }));
      }
      // Anything that is not an API path is a page navigation, so it must come back as HTML —
      // otherwise the gateway has no document to inject the overlay into.
      if (q.url.indexOf('/api/') !== 0) {
        r.writeHead(200, { 'content-type': 'text/html' });
        return r.end('<html><head></head><body>CLAUDE_APP_OK</body></html>');
      }
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(r => upstream.listen(0, r));
  backend = http.createServer((q, r) => {
    let b = ''; q.on('data', c => b += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, terminal: false, retryable: false, secondsRemaining: 1800, expiresAt: new Date(Date.now() + 1800000).toISOString(), serverTime: new Date().toISOString() }));
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'a1', label: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'V' }] } }));
      r.end('{}');
    });
  });
  await new Promise(r => backend.listen(0, r));
});
test.after(() => { try { upstream.close(); } catch (_) {} try { backend.close(); } catch (_) {} });

// ══ Setting OFF (default) ═══════════════════════════════════════════════════
test('OFF (default): Fable 5 never reaches upstream, on desktop or mobile', async () => {
  const PORT = 18910;
  const gw = boot(PORT, false);
  try {
    await waitUp(PORT);
    for (const [label, ua] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
      const cookie = await session(PORT, ua);
      received = [];
      // Straight request, as the picker would send it.
      await send(PORT, cookie, { prompt: 'hi', model: 'claude-fable-5' }, ua);
      // A handcrafted / modified request that never went through the UI at all.
      await send(PORT, cookie, { prompt: 'hi', model: 'fable5', auto_model_selection: true }, ua);
      // An existing conversation replaying its pinned model.
      await send(PORT, cookie, { conversation_uuid: 'c1', model: 'claude-fable-5-20260101' }, ua);

      assert.strictEqual(received.length, 3, label + ': all three reached upstream');
      for (const got of received) {
        assert.ok(!JSON.stringify(got).match(/fable/i), label + ': upstream must never see a fable id, got ' + JSON.stringify(got));
        if (got.model) assert.strictEqual(got.model, 'claude-opus-4-8', label + ': switched to the fallback');
      }
      assert.strictEqual(received[1].auto_model_selection, false, label + ': automatic model switching forced off');
      assert.strictEqual(received[2].conversation_uuid, 'c1', label + ': the conversation is preserved, not dropped');
    }
  } finally { try { gw.kill(); } catch (_) {} }
});

test('OFF: Fable 5 is absent from the model list the browser receives', async () => {
  const PORT = 18911;
  const gw = boot(PORT, false);
  try {
    await waitUp(PORT);
    const cookie = await session(PORT);
    const r = await req(PORT, 'GET', '/api/models', { cookie, 'user-agent': DESKTOP });
    assert.strictEqual(r.status, 200);
    assert.ok(!/fable/i.test(r.body), 'the picker payload must not contain Fable 5: ' + r.body);
    const o = JSON.parse(r.body);
    assert.deepStrictEqual(o.models.map(m => m.id), ['claude-opus-4-8', 'claude-sonnet-5'], 'every OTHER model survives, in order');
    assert.strictEqual(o.auto_model_selection, false, 'account auto-switching disabled');
  } finally { try { gw.kill(); } catch (_) {} }
});

test('OFF: requests for other models are completely unaffected', async () => {
  const PORT = 18912;
  const gw = boot(PORT, false);
  try {
    await waitUp(PORT);
    const cookie = await session(PORT);
    received = [];
    for (const m of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
      await send(PORT, cookie, { prompt: 'x', model: m });
    }
    assert.deepStrictEqual(received.map(r => r.model), ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
  } finally { try { gw.kill(); } catch (_) {} }
});

test('OFF: the overlay is told the setting and the exact message', async () => {
  const PORT = 18913;
  const gw = boot(PORT, false);
  try {
    await waitUp(PORT);
    const cookie = await session(PORT);
    const html = (await req(PORT, 'GET', '/new', { cookie, accept: 'text/html', 'user-agent': DESKTOP })).body;
    assert.match(html, /"allowFable5":false/, 'overlay config carries the setting');
    assert.match(html, /Fable 5 is disabled by your administrator\./, 'exact required wording is shipped');
  } finally { try { gw.kill(); } catch (_) {} }
});

// ══ Setting ON — reversibility ══════════════════════════════════════════════
test('ON: flipping the admin setting fully restores the original behaviour', async () => {
  const PORT = 18914;
  const gw = boot(PORT, true);
  try {
    await waitUp(PORT);
    const cookie = await session(PORT);
    received = [];
    await send(PORT, cookie, { prompt: 'hi', model: 'claude-fable-5', auto_model_selection: true });
    assert.strictEqual(received[0].model, 'claude-fable-5', 'Fable 5 passes through untouched');
    assert.strictEqual(received[0].auto_model_selection, true, 'auto-switching left alone');

    const list = (await req(PORT, 'GET', '/api/models', { cookie, 'user-agent': DESKTOP })).body;
    assert.match(list, /claude-fable-5/, 'Fable 5 is back in the picker');
    const html = (await req(PORT, 'GET', '/new', { cookie, accept: 'text/html', 'user-agent': DESKTOP })).body;
    assert.match(html, /"allowFable5":true/);
  } finally { try { gw.kill(); } catch (_) {} }
});

// ══ Nothing else regressed ═════════════════════════════════════════════════
test('PRESERVED: the app, overlay, downloads and lease gating still work', async () => {
  const PORT = 18915;
  const gw = boot(PORT, false);
  try {
    await waitUp(PORT);
    const cookie = await session(PORT);
    const html = (await req(PORT, 'GET', '/new', { cookie, accept: 'text/html', 'user-agent': DESKTOP })).body;
    assert.ok(html.includes('genz-sw-widget') || html.includes('__GENZ_GATEWAY__'), 'overlay still injected');
    // Access control untouched by this feature.
    const noSession = await send(PORT, '', { prompt: 'x', model: 'claude-fable-5' });
    assert.strictEqual(noSession.status, 403, 'still lease-gated');
    assert.strictEqual((await req(PORT, 'GET', '/sw.js', { 'user-agent': DESKTOP })).status, 404, 'service-worker block intact');
  } finally { try { gw.kill(); } catch (_) {} }
});
