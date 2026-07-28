'use strict';
/**
 * Every gateway log line must carry an ISO-8601 UTC timestamp.
 *
 * WHY THIS EXISTS. The gateway recorded WHAT happened but never WHEN. When a user reported a
 * mobile fault, there was no way to tell whether the events in the log came from before or after
 * the deploy that was supposed to fix it — the log could neither confirm nor refute the report,
 * which stalled a real diagnosis. A timestamp is only useful if it is on EVERY line, so this test
 * guards the property rather than the implementation.
 *
 * The stamp is a PREFIX, deliberately: it makes a time window greppable on the server
 * (`grep '2026-07-28T22:3'`) with no parsing, and it stamps events whose payload is empty. The
 * `[proxy-gw:<tool>]` marker and the JSON payload after it must stay byte-identical so existing
 * greps and field-extracting regexes keep working — that is asserted here too.
 *
 * Port 18955 (each gateway test file owns its own — a shared port silently breaks the OTHER
 * file's assertions, not yours).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('node:child_process');

const GW = path.join(__dirname, '..');
const PORT = 18955;
const SECRET = 's'.repeat(48);
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintLease() {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ jti: 'j' + crypto.randomBytes(6).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

let upstream, backend, gw, out = '';

function req(method, p, headers) {
  return new Promise((resolve) => {
    const r = http.request({ port: PORT, path: p, method, headers: headers || {} }, (res) => {
      const b = []; res.on('data', (c) => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    r.end();
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

test.before(async () => {
  upstream = http.createServer((q, r) => {
    if (q.url === '/new') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<html><head></head><body>app</body></html>'); }
    r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true}');
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
      CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough',
      PROXY_LOG_ALL: '1',            // make sure proxy lines are emitted for this test
    }),
  });
  gw.stdout.on('data', (c) => { out += c.toString(); });
  gw.stderr.on('data', (c) => { out += c.toString(); });
  await waitUp();
  // Drive real traffic so several DIFFERENT event types get logged.
  const r = await req('GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': DESKTOP });
  const sc = [].concat(r.headers['set-cookie'] || []).find((c) => /claude_session=/.test(c));
  await req('GET', '/new', { cookie: (sc || '').split(';')[0], accept: 'text/html', 'user-agent': DESKTOP });
  await new Promise((res) => setTimeout(res, 400));
});

test.after(() => {
  try { gw.kill(); } catch (_) {}
  try { upstream.close(); } catch (_) {}
  try { backend.close(); } catch (_) {}
});

test('the boot line is timestamped', () => {
  const boot = out.split('\n').find((l) => /proxy gateway listening on/.test(l));
  assert.ok(boot, 'the gateway logged a boot line');
  assert.match(boot, ISO_RE, 'boot line must start with an ISO-8601 UTC timestamp: ' + boot);
  assert.match(boot, /instance [0-9a-f]+/, 'and names the worker instance');
});

test('EVERY gateway event line is timestamped', () => {
  const lines = out.split('\n').filter((l) => l.includes('[proxy-gw:'));
  assert.ok(lines.length >= 2, 'sanity: the gateway emitted event lines (' + lines.length + ')');
  const unstamped = lines.filter((l) => !ISO_RE.test(l));
  assert.deepStrictEqual(unstamped, [], 'these event lines carry no timestamp');
});

test('the timestamp is real, current and UTC — not a fixed string', () => {
  const line = out.split('\n').find((l) => l.includes('[proxy-gw:'));
  const iso = line.slice(0, 24);
  const t = Date.parse(iso);
  assert.ok(!Number.isNaN(t), 'parses as a date: ' + iso);
  assert.ok(iso.endsWith('Z'), 'UTC, so it lines up with the backend log');
  assert.ok(Math.abs(Date.now() - t) < 5 * 60 * 1000, 'within minutes of now, i.e. genuinely current');
});

test('BACKWARD COMPATIBLE: the marker and the JSON payload are unchanged', () => {
  // Existing greps look for `[proxy-gw:claude] <event> {json}`. The stamp is a prefix, so both the
  // marker and everything after it must be exactly as before — otherwise every saved grep, and the
  // diagnostics that parse these lines, break silently.
  const line = out.split('\n').find((l) => /\[proxy-gw:claude\] \w+ \{/.test(l));
  assert.ok(line, 'a marker+event+JSON line still exists in the original shape');
  const after = line.slice(line.indexOf('[proxy-gw:'));
  assert.match(after, /^\[proxy-gw:claude\] [a-z_]+ \{/, 'shape after the stamp is unchanged: ' + after.slice(0, 60));
  const json = after.slice(after.indexOf('{'));
  assert.doesNotThrow(() => JSON.parse(json), 'the payload still parses as JSON');
});

test('a time-window grep selects only lines from that window', () => {
  // The whole point of a prefix: `grep '<iso-prefix>'` is a usable time filter on the server.
  const lines = out.split('\n').filter((l) => l.includes('[proxy-gw:'));
  const minute = lines[0].slice(0, 16);                 // YYYY-MM-DDTHH:MM
  const selected = lines.filter((l) => l.startsWith(minute));
  assert.ok(selected.length >= 1, 'a minute-prefix grep matches lines from that minute');
  assert.ok(selected.every((l) => ISO_RE.test(l)), 'and every match is a properly stamped line');
});
