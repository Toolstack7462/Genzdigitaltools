'use strict';
/**
 * Agent-side half of the 2026-10-05 WriteHuman incident (agent 3.5.1).
 *
 * 1. DIRECTIVES ON A REFUSAL. Once the stored access token had expired, every push from the active
 *    source was (correctly) refused 409 VERIFICATION_INCONCLUSIVE. The server's reply still carried
 *    the token-rotation nudge and any addressed admin command — but the 3.5.0 agent only read reply
 *    bodies on a 2xx, so it discarded the one instruction that would have got Chrome to rotate the
 *    token, and the server marked the command delivered. Recovery could not start.
 *
 * 2. WALL-CLOCK INTERVALS. The active source reported uptimeSec = -6877: its clock went BACKWARDS
 *    after the agent started. Every local interval (heartbeat due, nudge / relaunch cooldowns,
 *    activation deadline, uptime) was `Date.now() - lastX`, which goes negative after such a jump
 *    and stays below its threshold for as long as the jump — silencing heartbeats while the process
 *    looks perfectly alive. Local intervals now use a monotonic clock.
 *
 * All agent file paths are redirected to a temp dir: postToServer persists the device sequence, and
 * nothing here may touch a real installation's credential file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-agent-test-'));
process.env.WHV2_CONFIG = path.join(TMP, 'no-config.json');
process.env.WHV2_DEVICE_STATE = path.join(TMP, 'agent-device.json');
process.env.WHV2_STAND_DOWN = path.join(TMP, 'stood-down.json');
process.env.WHV2_LOCK_FILE = path.join(TMP, 'agent.lock');
process.env.WHV2_INGEST_URL = 'https://ingest.invalid/api/crm/proxy/agent/writehuman/cookies';

const AGENT = path.join(__dirname, '..', '..', 'writehuman-v2', 'agent', 'cookie-sync-agent.js');
const agent = require(AGENT);
const { postToServer, heartbeatDue, buildReport, monoNow, CFG } = agent;

const realFetch = global.fetch;
const realNow = Date.now;
test.after(() => { global.fetch = realFetch; Date.now = realNow; fs.rmSync(TMP, { recursive: true, force: true }); });

function reply(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}
function freshState() {
  return {
    device: { deviceId: 'dev_src', deviceKey: 'k', name: 'WIN-SRC', seq: 10 },
    lastHash: 'abc', startedAt: monoNow(), pollCount: 0, ingestFails: 0,
  };
}
const resyncFor = (id) => ({
  id: 'cmd_1', type: 'resync', tool: 'writehuman', targetDeviceId: id, nonce: 'n1',
  expiresAt: new Date(realNow() + 600000).toISOString(),
});

// ── 1. directives on a refusal ─────────────────────────────────────────────────────────────────
test('a 409 refusal that carries directives: the rotation nudge and the active-source flag are applied', async () => {
  const st = freshState();
  global.fetch = reply(409, { ok: false, code: 'VERIFICATION_INCONCLUSIVE', rotateTokenIn: 0, isActiveSource: true, deviceState: 'ACTIVE', standDown: false, command: null });
  const r = await postToServer(st, { cookies: [] });
  assert.strictEqual(r._status, 409, 'still reported as a refusal to the caller');
  assert.strictEqual(st.rotateTokenIn, 0, 'the nudge that lets Chrome rotate must not be discarded');
  assert.strictEqual(st.isActiveSource, true);
  assert.strictEqual(st.deviceState, 'ACTIVE');
  assert.strictEqual(st.ingestFails, 0, 'an answered 409 is not unreachability — no backoff');
});

test('a 409 refusal that carries an ADDRESSED command executes it (no more silently lost Re-sync)', async () => {
  const st = freshState();
  global.fetch = reply(409, { ok: false, code: 'VERIFICATION_INCONCLUSIVE', rotateTokenIn: null, isActiveSource: true, deviceState: 'ACTIVE', standDown: false, command: resyncFor('dev_src') });
  await postToServer(st, { cookies: [] });
  assert.strictEqual(st.lastHash, null, 'resync clears lastHash');
  assert.strictEqual(st.pendingAck && st.pendingAck.commandId, 'cmd_1');
});

test('a 409 still refuses a command addressed to ANOTHER device', async () => {
  const st = freshState();
  global.fetch = reply(409, { ok: false, code: 'VERIFICATION_INCONCLUSIVE', isActiveSource: true, deviceState: 'ACTIVE', standDown: false, command: resyncFor('dev_other') });
  await postToServer(st, { cookies: [] });
  assert.strictEqual(st.lastHash, 'abc');
  assert.ok(!st.pendingAck);
});

test('a terminal verdict on a refusal stands the agent down (and it persists)', async () => {
  const st = freshState();
  global.fetch = reply(409, { ok: false, code: 'VERIFICATION_INCONCLUSIVE', deviceState: 'REVOKED', standDown: true, standDownReason: 'revoked by admin', command: null });
  await postToServer(st, { cookies: [] });
  assert.strictEqual(st.standDown, true);
  assert.ok(fs.existsSync(process.env.WHV2_STAND_DOWN), 'stand-down must survive a restart');
  fs.rmSync(process.env.WHV2_STAND_DOWN, { force: true });
});

test('a 429 / 5xx (no directives) is still a transport failure: backoff, nothing executed', async () => {
  const st = freshState();
  global.fetch = reply(429, { ok: false, code: 'rate_limited' });
  await postToServer(st, { heartbeat: true });
  assert.strictEqual(st.ingestFails, 1);
  assert.strictEqual(st.rotateTokenIn, undefined);
  assert.strictEqual(st.lastHash, 'abc');
});

// ── 2. monotonic intervals ─────────────────────────────────────────────────────────────────────
function withClockJumpedBack(ms, fn) {
  const base = realNow();
  Date.now = () => base - ms;
  try { return fn(); } finally { Date.now = realNow; }
}

test('a heartbeat stays due when the wall clock jumps BACKWARDS (the -6877 s uptime incident)', () => {
  const st = freshState();
  st.lastHeartbeatAt = monoNow() - (CFG.heartbeatMs + 1000);
  assert.strictEqual(heartbeatDue(st), true);
  assert.strictEqual(withClockJumpedBack(3 * 3600 * 1000, () => heartbeatDue(st)), true,
    'a 3-hour backwards clock correction must not silence heartbeats for 3 hours');
});

test('a heartbeat is not due early, whatever the wall clock does', () => {
  const st = freshState();
  st.lastHeartbeatAt = monoNow() - 1000;
  assert.strictEqual(heartbeatDue(st), false);
  assert.strictEqual(withClockJumpedBack(-3 * 3600 * 1000, () => heartbeatDue(st)), false,
    'a FORWARD jump must not fire a burst of heartbeats either');
});

test('reported uptime is never negative after a backwards clock jump', () => {
  const st = freshState();
  st.startedAt = monoNow() - 60000;
  const up = withClockJumpedBack(2 * 3600 * 1000, () => buildReport(st).uptimeSec);
  assert.ok(up >= 59 && up <= 61, 'uptime ' + up);
});

test('no local interval in the polling/activation paths is measured with the wall clock', () => {
  const src = fs.readFileSync(AGENT, 'utf8');
  const body = (name) => {
    const start = src.indexOf((name === 'pushIfChanged' || name === 'runActivation' || name === 'nudgeTokenRotation') ? 'async function ' + name + '(' : 'function ' + name + '(');
    assert.ok(start >= 0, name + ' not found');
    let depth = 0; let i = src.indexOf('{', start);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i);
  };
  for (const fn of ['pushIfChanged', 'runActivation', 'nudgeTokenRotation', 'buildReport', 'heartbeatDue']) {
    assert.doesNotMatch(body(fn), /Date\.now\(\)\s*-\s*\(?state\.|Date\.now\(\)\s*-\s*act\.|Date\.now\(\)\s*</,
      fn + ' must measure local intervals with monoNow()');
  }
});

// ── 3. 3.5.2: the success log no longer throws; token expiry TIMES are logged ───────────────────
test('the cookie_synchronized log does not reference an undeclared variable (`forced is not defined`)', () => {
  // In 3.5.0/3.5.1 every SUCCESSFUL sync threw ReferenceError right after updating state, so a
  // success surfaced in agent.log only as `tick_error {"error":"forced is not defined"}` (107 times
  // on the 2026-10-05 source). It did not break syncing — it hid every success from diagnosis.
  const src = fs.readFileSync(AGENT, 'utf8');
  const start = src.indexOf('async function pushIfChanged(');
  let depth = 0; let i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  const body = src.slice(start, i);
  if (/\bforced\b/.test(body)) assert.match(body, /\b(?:let|const|var)\s+forced\b/, '`forced` is used but never declared');
});

const { authTokenExpiry } = agent;
const REF = 'hicfsbrfkzsxbwayibfm';
function sessionCookieValue(expiresAt) {
  const tok = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url') + '.sig';
  return 'base64-' + Buffer.from(JSON.stringify({ access_token: tok, refresh_token: 'rt-secret', expires_at: expiresAt })).toString('base64');
}

test('authTokenExpiry reads only the expiry TIME from a whole auth cookie', () => {
  const exp = 1_790_000_000;
  const out = authTokenExpiry([{ name: 'sb-' + REF + '-auth-token', value: sessionCookieValue(exp) }], REF);
  assert.strictEqual(out, new Date(exp * 1000).toISOString());
});

test('authTokenExpiry joins chunked auth cookies in order', () => {
  const exp = 1_790_000_123;
  const v = sessionCookieValue(exp);
  const half = Math.floor(v.length / 2);
  const out = authTokenExpiry([
    { name: 'sb-' + REF + '-auth-token.1', value: v.slice(half) },
    { name: 'sb-' + REF + '-auth-token.0', value: v.slice(0, half) },
  ], REF);
  assert.strictEqual(out, new Date(exp * 1000).toISOString());
});

test('authTokenExpiry never returns token material, and is null when unreadable', () => {
  assert.strictEqual(authTokenExpiry([], REF), null);
  assert.strictEqual(authTokenExpiry([{ name: 'sb-' + REF + '-auth-token', value: 'garbage' }], REF), null);
  const out = String(authTokenExpiry([{ name: 'sb-' + REF + '-auth-token', value: sessionCookieValue(1_790_000_000) }], REF));
  assert.doesNotMatch(out, /eyJ|rt-secret/);
});
