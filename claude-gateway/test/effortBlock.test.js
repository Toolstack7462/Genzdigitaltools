'use strict';
/**
 * INTEGRATION — the effort allowlist through the real server.js.
 *
 * POLICY: only Low and Medium may be used. High / Extra / Extra High / Very High / Max are removed
 * from the picker on the way back and rewritten to Medium on the way upstream — and the upstream
 * rewrite is the one that actually matters, because the picker is claude.ai's own React state and
 * a modified body, a replayed request or a devtools fetch all bypass the UI.
 *
 * Asserted here, end to end:
 *   • what the UPSTREAM actually receives (the unbypassable block)
 *   • what the BROWSER actually receives (the picker removal)
 *   • that Opus and Haiku stay selectable, and only their effort is capped
 *   • that Fable 5 remains blocked (the pre-existing policy is not weakened)
 *   • that the reversible kill-switch restores the previous behaviour exactly
 *
 * Port 18960 (each gateway test file owns its own — a shared port silently breaks the OTHER
 * file's assertions, not yours).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('node:child_process');

const GW = path.join(__dirname, '..');
const SECRET = 's'.repeat(48);
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
let received = [];   // every completion body the upstream actually saw

function req(port, method, p, headers, body) {
  return new Promise((resolve) => {
    const r = http.request({ port, path: p, method, headers: headers || {} }, (res) => {
      const b = []; res.on('data', (c) => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}
async function waitUp(port) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await req(port, 'GET', '/__genz/health')).status === 200) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('gateway ' + port + ' did not boot');
}
function boot(port, allowAllEfforts) {
  const env = Object.assign({}, process.env, {
    PORT: String(port), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
    LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
  });
  if (allowAllEfforts) env.CLAUDE_ALLOW_ALL_EFFORTS = '1'; else delete env.CLAUDE_ALLOW_ALL_EFFORTS;
  return spawn(process.execPath, ['server.js'], { cwd: GW, env, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function session(port, ua) {
  const r = await req(port, 'GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': ua || DESKTOP });
  const sc = [].concat(r.headers['set-cookie'] || []).find((c) => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set the session cookie');
  return sc.split(';')[0];
}
const send = (port, cookie, obj, ua) => req(port, 'POST',
  '/api/organizations/ORG/chat_conversations/CONV/completion',
  { cookie, 'content-type': 'application/json', 'user-agent': ua || DESKTOP }, JSON.stringify(obj));

test.before(async () => {
  upstream = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => {
      if (q.method === 'POST') { try { received.push(JSON.parse(b)); } catch (_) { received.push({ raw: b }); } }
      // The selectable effort levels the picker renders, plus the model list beside them.
      if (q.url.indexOf('/api/settings') === 0) {
        r.writeHead(200, { 'content-type': 'application/json' });
        return r.end(JSON.stringify({
          effort_levels: [
            { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' },
            { id: 'extra_high', name: 'Extra High' }, { id: 'max', name: 'Max' },
          ],
          models: [
            { id: 'claude-sonnet-5', name: 'Sonnet 5' }, { id: 'claude-opus-5', name: 'Opus 5' },
            { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' }, { id: 'claude-fable-5', name: 'Fable 5' },
          ],
          conversation: { model: 'claude-opus-5', effort: 'extra_high' },
        }));
      }
      if (q.url === '/new') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<html><head></head><body>app</body></html>'); }
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
});
test.after(() => { try { upstream.close(); } catch (_) {} try { backend.close(); } catch (_) {} });

// ── ENFORCED (default) ──────────────────────────────────────────────────────
test('ENFORCED: every blocked effort is rewritten to medium before it reaches Claude', async () => {
  const port = 18960, gw = boot(port, false);
  try {
    await waitUp(port);
    for (const ua of [DESKTOP, MOBILE]) {
      const label = ua === MOBILE ? 'mobile' : 'desktop';
      const cookie = await session(port, ua);
      received = [];
      for (const level of ['high', 'extra_high', 'very high', 'max', 'maximum', 'ultra']) {
        const r = await send(port, cookie, { prompt: 'hi', effort: level }, ua);
        assert.strictEqual(r.status, 200, label + ' ' + level + ': the request still succeeds');
      }
      assert.strictEqual(received.length, 6, label + ': all six reached upstream');
      for (const got of received) {
        assert.strictEqual(got.effort, 'medium', label + ': upstream must only ever see medium, got ' + got.effort);
      }
    }
  } finally { gw.kill(); }
});

test('ENFORCED: Low and Medium are accepted and passed through unchanged', async () => {
  const port = 18961, gw = boot(port, false);
  try {
    await waitUp(port);
    const cookie = await session(port);
    received = [];
    await send(port, cookie, { prompt: 'a', effort: 'low' });
    await send(port, cookie, { prompt: 'b', effort: 'medium' });
    assert.deepStrictEqual(received.map((r) => r.effort), ['low', 'medium'], 'permitted levels are untouched');
    assert.deepStrictEqual(received.map((r) => r.prompt), ['a', 'b'], 'the message itself is never altered');
  } finally { gw.kill(); }
});

test('ENFORCED: the blocked levels are absent from the list the BROWSER receives', async () => {
  const port = 18962, gw = boot(port, false);
  try {
    await waitUp(port);
    const cookie = await session(port);
    const r = await req(port, 'GET', '/api/settings', { cookie, accept: 'application/json', 'user-agent': DESKTOP });
    const o = JSON.parse(r.body);

    assert.deepStrictEqual(o.effort_levels.map((e) => e.id), ['low', 'medium'], 'only Low and Medium survive');
    assert.ok(!/high|extra|max|ultra/i.test(JSON.stringify(o.effort_levels)), 'no blocked level in any spelling');

    // A conversation SAVED at a blocked level reopens at medium — "Opus Extra" -> "Opus Medium".
    assert.strictEqual(o.conversation.effort, 'medium');
    assert.strictEqual(o.conversation.model, 'claude-opus-5', 'the MODEL is untouched: Opus stays selectable');

    // The pre-existing model policy is not weakened by any of this.
    const ids = o.models.map((m) => m.id);
    assert.ok(!ids.some((i) => /fable/i.test(i)), 'Fable 5 remains absent from the picker');
    assert.ok(ids.includes('claude-sonnet-5') && ids.includes('claude-opus-5') && ids.includes('claude-haiku-4-5-20251001'),
      'Sonnet, Opus and Haiku all remain selectable');
  } finally { gw.kill(); }
});

test('ENFORCED: Opus and Haiku stay usable — only the EFFORT is capped', async () => {
  const port = 18963, gw = boot(port, false);
  try {
    await waitUp(port);
    const cookie = await session(port);
    received = [];
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']) {
      await send(port, cookie, { model, effort: 'max' });
    }
    assert.deepStrictEqual(received.map((r) => r.model), ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
      'the requested model always reaches Claude unchanged');
    for (const got of received) assert.strictEqual(got.effort, 'medium', 'while the effort is capped');
  } finally { gw.kill(); }
});

test('ENFORCED: the overlay is told the allowlist and the exact message', async () => {
  const port = 18964, gw = boot(port, false);
  try {
    await waitUp(port);
    const cookie = await session(port);
    const r = await req(port, 'GET', '/new', { cookie, accept: 'text/html', 'user-agent': DESKTOP });
    const m = r.body.match(/window\.__GENZ_GATEWAY__=(\{.*?\});/);
    assert.ok(m, 'the overlay config is injected');
    const cfg = JSON.parse(m[1]);
    assert.deepStrictEqual(cfg.allowedEfforts, ['low', 'medium']);
    assert.strictEqual(cfg.defaultEffort, 'medium', 'Medium is the default');
    assert.strictEqual(cfg.defaultModel, 'claude-sonnet-5', 'Sonnet is the default model');
    assert.ok(cfg.blockedEffortMsg && cfg.blockedEffortMsg.length > 0, 'a reason to show the user');
    assert.strictEqual(cfg.allowFable5, false, 'Fable 5 stays blocked');
  } finally { gw.kill(); }
});

test('ENFORCED: an unrecognised effort vocabulary is left ALONE, never broken', async () => {
  // Rewriting a value we cannot identify could produce a request claude.ai rejects — breaking chat
  // to enforce a preference. Fail-open is the deliberate, correct trade.
  const port = 18965, gw = boot(port, false);
  try {
    await waitUp(port);
    const cookie = await session(port);
    received = [];
    const r = await send(port, cookie, { prompt: 'hi', effort: 'turbo-9000' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(received[0].effort, 'turbo-9000', 'forwarded untouched');
  } finally { gw.kill(); }
});

test('ENFORCED: a stale default in the environment cannot re-open a blocked level', async () => {
  const port = 18966;
  const gw = spawn(process.execPath, ['server.js'], {
    cwd: GW, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      PORT: String(port), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
      TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
      API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
      CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
      CLAUDE_DEFAULT_EFFORT: 'max',   // a leftover .htaccess value
    }),
  });
  try {
    await waitUp(port);
    const cookie = await session(port);
    const r = await req(port, 'GET', '/new', { cookie, accept: 'text/html', 'user-agent': DESKTOP });
    const cfg = JSON.parse(r.body.match(/window\.__GENZ_GATEWAY__=(\{.*?\});/)[1]);
    assert.strictEqual(cfg.defaultEffort, 'medium',
      'a blocked configured default clamps to medium — the picker and the enforced value must agree');
  } finally { gw.kill(); }
});

// ── KILL-SWITCH: the previous behaviour, restored exactly ───────────────────
test('KILL-SWITCH: CLAUDE_ALLOW_ALL_EFFORTS=1 restores the original behaviour', async () => {
  const port = 18967, gw = boot(port, true);
  try {
    await waitUp(port);
    const cookie = await session(port);
    received = [];
    await send(port, cookie, { prompt: 'hi', effort: 'max' });
    assert.strictEqual(received[0].effort, 'max', 'the request is forwarded untouched');

    const r = await req(port, 'GET', '/api/settings', { cookie, accept: 'application/json', 'user-agent': DESKTOP });
    const o = JSON.parse(r.body);
    assert.deepStrictEqual(o.effort_levels.map((e) => e.id), ['low', 'medium', 'high', 'extra_high', 'max'],
      'every level is back in the picker');
    assert.strictEqual(o.conversation.effort, 'extra_high', 'a saved level is no longer migrated');

    const nav = await req(port, 'GET', '/new', { cookie, accept: 'text/html', 'user-agent': DESKTOP });
    const cfg = JSON.parse(nav.body.match(/window\.__GENZ_GATEWAY__=(\{.*?\});/)[1]);
    assert.strictEqual(cfg.allowedEfforts, null, 'the overlay is told enforcement is off');

    // The kill-switch is effort-only: Fable 5 must STILL be blocked.
    assert.ok(!o.models.some((m) => /fable/i.test(m.id)), 'the model policy is independent and still enforced');
  } finally { gw.kill(); }
});
