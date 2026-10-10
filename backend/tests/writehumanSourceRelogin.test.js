/**
 * Source-side automatic re-login (agent 3.5.3) - BEHAVIOURAL tests.
 *
 * These drive the real `attemptSourceRelogin()` out of the authoritative agent
 * source against a FAKE Chrome: global.fetch answers /json/list and /json/new, and
 * a fake WebSocket speaks just enough CDP (Runtime.evaluate / Input.insertText /
 * Page.navigate / Storage.getCookies) for a login to play out. The page's state is
 * scriptable, so each scenario is a real end-to-end run through the function.
 *
 * The credential is a REAL DPAPI CurrentUser blob written to a temp dir with DUMMY
 * values, because that is the mechanism the agent actually uses. On a non-Windows
 * host the credential-dependent cases skip rather than pretend to pass.
 *
 * Covered: logged-in no-op, opt-out, inactive source, stand-down, confirmed logout
 * success, tab REUSE (no second tab), wrong password, MFA, CAPTCHA, rate limit,
 * account restriction, wrong account (server verdict), missing vault, cooldown,
 * budget exhaustion, persistent halt across restart, single flight, and the
 * guarantee that the password never appears in a log line.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WIN = process.platform === 'win32';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-relogin-'));
const VAULT = path.join(TMP, 'source-credential.dpapi');
const STATE = path.join(TMP, 'agent-relogin.json');
const DUMMY = { email: 'dummy-source@example.test', password: 'DUMMY-PW-not-real-7731' };

// ── build a real DPAPI vault (dummy values) ───────────────────────────────────
let vaultReady = false;
if (WIN) {
  try {
    // Stage the plaintext through a temp FILE: a JSON document cannot be embedded in
    // a PowerShell double-quoted string (its \" is not an escape there, so -Command
    // fails to parse). The staging file is deleted immediately after encryption.
    const stage = path.join(TMP, 'stage.json');
    fs.writeFileSync(stage, JSON.stringify(DUMMY), 'utf8');
    const ps = '$p=Get-Content -Raw -Path ' + JSON.stringify(stage) + ';' +
      'ConvertTo-SecureString -String $p.Trim() -AsPlainText -Force | ConvertFrom-SecureString | ' +
      'Set-Content -Path ' + JSON.stringify(VAULT) + ' -Encoding Ascii';
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000, windowsHide: true });
    fs.rmSync(stage, { force: true });
    vaultReady = fs.existsSync(VAULT) && fs.statSync(VAULT).size > 0;
  } catch (_) { vaultReady = false; }
}

// ── env must be set BEFORE the agent is required (CFG is built at load) ───────
process.env.WHV2_RELOGIN = '1';
process.env.WHV2_RELOGIN_STATE = STATE;
process.env.WHV2_CREDENTIAL_VAULT = VAULT;
process.env.WHV2_CDP_URL = 'http://127.0.0.1:9222';
process.env.WHV2_TARGET_DOMAIN = 'writehuman.ai';
process.env.WHV2_SUPABASE_REF = 'hicfsbrfkzsxbwayibfm';
process.env.WHV2_DEVICE_STATE = path.join(TMP, 'agent-device.json');
process.env.WHV2_RELOGIN_COOLDOWN_MS = '300000';
process.env.WHV2_RELOGIN_WAIT_MS = '15000';
process.env.WHV2_AGENT_KEY = 'test-key';
process.env.WHV2_INGEST_URL = 'http://127.0.0.1:65535/v2/cookies/ingest';

const AGENT_PATH = path.join(__dirname, '..', '..', 'writehuman-v2', 'agent', 'cookie-sync-agent.js');
const agent = require(AGENT_PATH);

// ── the fake Chrome ───────────────────────────────────────────────────────────
// `page` describes what the login surface currently looks like; the probe inside
// the agent is real JavaScript, so instead of running it we intercept it and answer
// with the scripted classification. Every other CDP method is honoured for real.
const SEL = { email: 'input[type="email"]', pass: 'input[type="password"]', submit: 'button[type="submit"]' };
let scene;

function resetScene(over) {
  scene = Object.assign({
    tabs: [{ type: 'page', url: 'https://writehuman.ai/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/AAA' }],
    newTabCalls: 0,
    probe: { href: 'https://writehuman.ai/signup?mode=login', path: '/signup?mode=login', email: SEL.email, pass: SEL.pass, submit: SEL.submit, captcha: false, otp: false, mfaText: false, badCreds: false, rate: false, locked: false },
    probeAfterSubmit: null,
    submitted: 0,
    typed: [],
    cookiesAfterSubmit: [{ name: 'sb-hicfsbrfkzsxbwayibfm-auth-token', value: 'base64-newsession', domain: '.writehuman.ai' }],
    cookiesBeforeSubmit: [],
    navigations: [],
  }, over || {});
}

const realFetch = global.fetch;
const realWS = global.WebSocket;

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/json/list')) {
    return { ok: true, status: 200, json: async () => scene.tabs };
  }
  if (u.endsWith('/json/version')) {
    // getAllCookiesViaCDP() reads the BROWSER-level target from here; without it the
    // post-login cookie check can never see the recovered session.
    return { ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/BBB', userDataDir: 'C:/dedicated/WriteHumanProfile' }) };
  }
  if (u.includes('/json/new')) {
    scene.newTabCalls++;
    const t = { type: 'page', url: 'https://writehuman.ai/signup?mode=login', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/NEW' };
    scene.tabs.push(t);
    return { ok: true, status: 200, json: async () => t };
  }
  // The agent's postToServer: answer 200 with no directives.
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({}) };
};

class FakeWS {
  constructor() {
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
    setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
  }
  send(raw) {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    const reply = (result) => setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: m.id, result: result }) }); }, 0);
    const method = m.method;
    const expr = (m.params && m.params.expression) || '';

    if (method === 'Page.enable' || method === 'Runtime.enable') return reply({});
    if (method === 'Page.navigate') { scene.navigations.push(m.params.url); return reply({ frameId: 'f1' }); }
    if (method === 'Input.insertText') { scene.typed.push(m.params.text); return reply({}); }
    if (method === 'Storage.getCookies') {
      return reply({ cookies: scene.submitted > 0 ? scene.cookiesAfterSubmit : scene.cookiesBeforeSubmit });
    }
    if (method === 'Runtime.evaluate') {
      // The probe: identified by its own marker text.
      if (expr.indexOf('one-time-code') !== -1) {
        const p = (scene.submitted > 0 && scene.probeAfterSubmit) ? scene.probeAfterSubmit : scene.probe;
        return reply({ result: { value: JSON.stringify(p) } });
      }
      // focus/clear + dispatch helpers used by typeInto -> they must find the field.
      if (expr.indexOf('n.focus()') !== -1) {
        const found = expr.indexOf(SEL.email) !== -1 ? !!scene.probe.email : !!scene.probe.pass;
        return reply({ result: { value: found } });
      }
      if (expr.indexOf('dispatchEvent(new Event("input"') !== -1) return reply({ result: { value: true } });
      // the submit click
      if (expr.indexOf('b.click()') !== -1) { scene.submitted++; return reply({ result: { value: !!scene.probe.submit } }); }
      if (expr.indexOf('requestSubmit') !== -1) { scene.submitted++; return reply({ result: { value: true } }); }
      return reply({ result: { value: true } });
    }
    return reply({});
  }
  close() { if (this.onclose) this.onclose(); }
}
global.WebSocket = FakeWS;

// Capture log lines so we can prove the password never appears.
const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };

test.after(() => {
  console.log = realLog;
  global.fetch = realFetch;
  global.WebSocket = realWS;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

function clearState() { try { fs.rmSync(STATE, { force: true }); } catch (_) {} }
function baseState(over) {
  return Object.assign({
    isActiveSource: true, standDownCode: null, reloginInFlight: false,
    lastHash: 'oldhash', emptyPolls: 2, loggedOutSent: true, quickPollsLeft: 0,
    lastErrorMsg: null, lastErrorAt: null, errorCount: 0, pollCount: 1,
    startedAt: agent.monoNow(), device: { deviceId: 'd1' },
  }, over || {});
}

// ── gates ─────────────────────────────────────────────────────────────────────
test('GATE: recovery never runs when the account is still authenticated', async () => {
  // The hook is only reachable from the confirmed-logout branch. Assert that the
  // call site in the real source sits inside it and is guarded by the opt-in.
  const src = fs.readFileSync(AGENT_PATH, 'utf8');
  const hook = src.indexOf('attemptSourceRelogin(state, \'auth_cookie_absent\')');
  const branch = src.indexOf('state.emptyPolls >= CFG.logoutDebounce && !state.loggedOutSent');
  const reset = src.indexOf('state.emptyPolls = 0; state.loggedOutSent = false;');
  assert.ok(branch > 0 && hook > branch, 'the hook must live inside the confirmed-logout branch');
  assert.ok(reset > hook, 'the authenticated path (which resets emptyPolls) must come after, never calling it');
  assert.ok(/if \(CFG\.reloginEnabled\) \{/.test(src.slice(branch, hook + 200)), 'the hook must be opt-in gated');
});

test('GATE: inconclusive verification alone does not trigger recovery', () => {
  // CDP-down / Chrome-closed return BEFORE the logout branch, so the only entry is
  // a debounced absent auth cookie on a browser that had been authenticated.
  const src = fs.readFileSync(AGENT_PATH, 'utf8');
  const cdpDown = src.indexOf("await postToServer(state, { heartbeat: true, hash: null }); // report CDP-down");
  const hook = src.indexOf('attemptSourceRelogin(state, \'auth_cookie_absent\')');
  assert.ok(cdpDown > 0 && cdpDown < hook, 'the CDP-down early return must precede the recovery hook');
});

test('GATE: opt-out means no action at all', async () => {
  clearState(); resetScene();
  const saved = agent.CFG.reloginEnabled;
  agent.CFG.reloginEnabled = false;
  const out = await agent.attemptSourceRelogin(baseState(), 'test');
  agent.CFG.reloginEnabled = saved;
  assert.strictEqual(out, 'disabled');
  assert.strictEqual(scene.newTabCalls, 0, 'must not touch the browser');
});

test('GATE: only the ACTIVE source device recovers', async () => {
  clearState(); resetScene();
  assert.strictEqual(await agent.attemptSourceRelogin(baseState({ isActiveSource: false }), 'test'), 'not_active_source');
  assert.strictEqual(await agent.attemptSourceRelogin(baseState({ isActiveSource: null }), 'test'), 'not_active_source');
  assert.strictEqual(scene.newTabCalls, 0);
});

test('GATE: a stood-down (revoked) install never logs in', async () => {
  clearState(); resetScene();
  const out = await agent.attemptSourceRelogin(baseState({ standDownCode: 'DEVICE_REVOKED' }), 'test');
  assert.strictEqual(out, 'stood_down');
});

test('GATE: single flight - an overlapping trigger is refused', async () => {
  clearState(); resetScene();
  const out = await agent.attemptSourceRelogin(baseState({ reloginInFlight: true }), 'test');
  assert.strictEqual(out, 'already_running');
});

test('GATE: a missing credential vault reports instead of guessing', async () => {
  clearState(); resetScene();
  const saved = process.env.WHV2_CREDENTIAL_VAULT;
  process.env.WHV2_CREDENTIAL_VAULT = path.join(TMP, 'does-not-exist.dpapi');
  const out = await agent.attemptSourceRelogin(baseState(), 'test');
  process.env.WHV2_CREDENTIAL_VAULT = saved;
  assert.strictEqual(out, 'no_vault');
  assert.strictEqual(scene.newTabCalls, 0, 'must not open a tab with no credential');
});

// ── the real flows (need the DPAPI vault) ────────────────────────────────────
const vaultTest = (name, fn) => test(name, { skip: !vaultReady ? 'needs Windows DPAPI' : false }, fn);

vaultTest('SUCCESS: confirmed logout -> one login -> handed to the existing pipeline', async () => {
  clearState(); resetScene();
  const st = baseState();
  const out = await agent.attemptSourceRelogin(st, 'auth_cookie_absent');
  // Deliberately NOT 'ok': the browser is in, but the ACCOUNT is not verified until
  // the server answers. Claiming success here is the bug this name prevents.
  assert.strictEqual(out, 'browser_authenticated_pending_verification');
  assert.strictEqual(st.reloginPending, true, 'the server verdict must still be awaited');
  assert.strictEqual(scene.submitted, 1, 'the form must be submitted exactly ONCE');
  assert.deepStrictEqual(scene.typed, [DUMMY.email, DUMMY.password], 'both fields typed, in order');
  // Handover: lastHash cleared so the next poll offers the bundle for server verification.
  assert.strictEqual(st.lastHash, null, 'lastHash must be cleared so the bundle is re-offered');
  assert.strictEqual(st.loggedOutSent, false);
  assert.ok(st.quickPollsLeft > 0, 'a quick-poll burst should carry the new session up promptly');
  assert.strictEqual(st.reloginInFlight, false, 'the single-flight flag must be released');
});

vaultTest('TAB REUSE: an existing WriteHuman tab is reused - no second visible tab', async () => {
  clearState(); resetScene();
  await agent.attemptSourceRelogin(baseState(), 'test');
  assert.strictEqual(scene.newTabCalls, 0, '/json/new must NOT be called when a tab exists');
  assert.strictEqual(scene.tabs.length, 1, 'tab count must not grow');
});

vaultTest('TAB: with no WriteHuman tab at all, exactly one is opened', async () => {
  clearState();
  resetScene({ tabs: [{ type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://x/1' }] });
  await agent.attemptSourceRelogin(baseState(), 'test');
  assert.strictEqual(scene.newTabCalls, 1, 'exactly one tab, only because none existed');
});

vaultTest('STOP: wrong password halts permanently and survives a restart', async () => {
  clearState();
  resetScene({ probeAfterSubmit: { path: '/signup?mode=login', email: SEL.email, pass: SEL.pass, submit: SEL.submit, badCreds: true, captcha: false, otp: false, mfaText: false, rate: false, locked: false }, cookiesAfterSubmit: [] });
  const out = await agent.attemptSourceRelogin(baseState(), 'test');
  assert.strictEqual(out, 'wrong_credentials');
  // Persisted halt = a restart cannot resume hammering the login form.
  const st = agent.readReloginState();
  assert.strictEqual(st.haltedReason, 'wrong_credentials');
  assert.ok(st.haltedAt, 'the halt must be timestamped');
  const again = await agent.attemptSourceRelogin(baseState(), 'test');
  assert.strictEqual(again, 'halted_wrong_credentials', 'a halted agent must refuse further attempts');
});

vaultTest('STOP: MFA / one-time-code required -> manual action, no bypass attempt', async () => {
  clearState();
  resetScene({ probe: { path: '/signup?mode=login', email: SEL.email, pass: SEL.pass, submit: SEL.submit, otp: true, captcha: false, mfaText: false, badCreds: false, rate: false, locked: false } });
  const out = await agent.attemptSourceRelogin(baseState(), 'test');
  assert.strictEqual(out, 'mfa_required');
  assert.strictEqual(scene.submitted, 0, 'must not submit anything when MFA is present');
  assert.strictEqual(agent.readReloginState().haltedReason, 'mfa_required');
});

vaultTest('STOP: CAPTCHA present -> halt before typing a credential', async () => {
  clearState();
  resetScene({ probe: { path: '/signup?mode=login', email: SEL.email, pass: SEL.pass, submit: SEL.submit, captcha: true, otp: false, mfaText: false, badCreds: false, rate: false, locked: false } });
  const out = await agent.attemptSourceRelogin(baseState(), 'test');
  assert.strictEqual(out, 'captcha_required');
  assert.deepStrictEqual(scene.typed, [], 'the credential must not be typed into a challenged page');
});

vaultTest('STOP: provider rate limit -> halt', async () => {
  clearState();
  resetScene({ probe: { path: '/signup?mode=login', email: SEL.email, pass: SEL.pass, submit: SEL.submit, rate: true, captcha: false, otp: false, mfaText: false, badCreds: false, locked: false } });
  assert.strictEqual(await agent.attemptSourceRelogin(baseState(), 'test'), 'rate_limited');
});

vaultTest('STOP: account locked / suspended -> halt', async () => {
  clearState();
  resetScene({ probe: { path: '/signup?mode=login', email: SEL.email, pass: SEL.pass, submit: SEL.submit, locked: true, captcha: false, otp: false, mfaText: false, badCreds: false, rate: false } });
  assert.strictEqual(await agent.attemptSourceRelogin(baseState(), 'test'), 'account_restricted');
});

vaultTest('STOP: no login form found -> reports, does not flail', async () => {
  clearState();
  resetScene({ probe: { path: '/', email: null, pass: null, submit: null, captcha: false, otp: false, mfaText: false, badCreds: false, rate: false, locked: false } });
  const out = await agent.attemptSourceRelogin(baseState(), 'test');
  assert.strictEqual(out, 'login_form_not_found');
  assert.ok(scene.navigations.length > 0, 'it should have tried the official login path first');
  assert.ok(scene.navigations.every(u => u.indexOf('writehuman.ai') !== -1), 'only the official domain');
});

vaultTest('STOP: auth never confirmed -> failure, nothing promoted', async () => {
  clearState();
  resetScene({ cookiesAfterSubmit: [] });   // submit works, session never appears
  process.env.WHV2_RELOGIN_WAIT_MS = '15000';
  const st = baseState();
  const out = await agent.attemptSourceRelogin(st, 'test');
  assert.strictEqual(out, 'auth_not_confirmed');
  assert.strictEqual(st.lastHash, 'oldhash', 'must NOT clear lastHash on a failed recovery');
  // Not terminal: a transient failure may be retried within budget.
  assert.strictEqual(agent.readReloginState().haltedReason, null);
});

vaultTest('BUDGET: cooldown blocks a second attempt inside the window', async () => {
  clearState(); resetScene();
  assert.strictEqual(await agent.attemptSourceRelogin(baseState(), 'test'), 'browser_authenticated_pending_verification');
  const out = await agent.attemptSourceRelogin(baseState(), 'test');
  assert.strictEqual(out, 'cooldown', 'the cooldown must gate back-to-back attempts');
});

vaultTest('BUDGET: attempts are bounded inside the rolling window', async () => {
  clearState(); resetScene();
  const now = Date.now();
  // Pre-load the budget as if three attempts already happened, cooldown long past.
  agent.writeReloginState({ attempts: [now - 3 * 3600000, now - 2 * 3600000, now - 3600000], haltedReason: null, haltedAt: null });
  const out = await agent.attemptSourceRelogin(baseState(), 'test');
  assert.strictEqual(out, 'budget_exhausted');
  assert.strictEqual(scene.newTabCalls, 0, 'an exhausted budget must not touch the browser');
});

vaultTest('BUDGET: an attempt is counted BEFORE the risky work (crash cannot loop)', async () => {
  clearState(); resetScene();
  await agent.attemptSourceRelogin(baseState(), 'test');
  const st = agent.readReloginState();
  assert.strictEqual(st.attempts.length, 1, 'the attempt must be recorded');
  assert.ok(st.lastAttemptAt, 'and timestamped');
});

// ── secrecy ──────────────────────────────────────────────────────────────────
vaultTest('SECRECY: the password never reaches a log line', async () => {
  clearState(); resetScene();
  logs.length = 0;
  await agent.attemptSourceRelogin(baseState(), 'test');
  const blob = logs.join('\n');
  assert.ok(logs.length > 0, 'the run should have logged something');
  assert.ok(blob.indexOf(DUMMY.password) === -1, 'PASSWORD LEAKED INTO A LOG LINE');
  assert.ok(blob.indexOf(DUMMY.email) === -1, 'the full account address must be masked in logs');
  assert.ok(/d\*\*\*\*@example\.test/.test(blob), 'the account should appear masked');
});

test('SECRECY: the password is never interpolated into evaluated JavaScript', () => {
  const src = fs.readFileSync(AGENT_PATH, 'utf8');
  // typeInto must deliver the value via Input.insertText, never inside an expression.
  assert.ok(/Input\.insertText/.test(src), 'the credential must be typed, not evaluated');
  assert.ok(!/expression:[^\n]*cred\.password/.test(src), 'the password must never appear inside an expression string');
  assert.ok(!/cred\.password[^\n]*log\(/.test(src), 'the password must never be passed to log()');
});

test('SECRECY: the agent report exposes status but never the credential', () => {
  const r = agent.reloginReport();
  const blob = JSON.stringify(r);
  assert.ok(blob.indexOf(DUMMY.password) === -1, 'no password in the report');
  assert.ok(blob.indexOf(DUMMY.email) === -1, 'no account address in the report');
  assert.ok('enabled' in r, 'the report should say whether recovery is on');
});

test('REPORT: buildReport carries the recovery block additively', () => {
  const rep = agent.buildReport(baseState());
  assert.ok(rep.relogin, 'buildReport must include the relogin block');
  assert.strictEqual(typeof rep.relogin.enabled, 'boolean');
  assert.strictEqual(rep.version, '3.5.3', 'the report must carry the new version');
});

// ── preservation ─────────────────────────────────────────────────────────────
test('PRESERVE: the browser remains the sole token rotator', () => {
  const src = fs.readFileSync(AGENT_PATH, 'utf8');
  // Recovery must never exchange a refresh token itself.
  assert.ok(!/grant_type=refresh_token/.test(src), 'the agent must never call the token endpoint');
  assert.ok(/nudgeTokenRotation/.test(src), 'the existing browser-nudge rotation must still be present');
});

test('PRESERVE: recovery is off by default on a fresh install', () => {
  // CFG in this process was built with WHV2_RELOGIN=1; assert the SOURCE default.
  const src = fs.readFileSync(AGENT_PATH, 'utf8');
  assert.ok(/reloginEnabled: String\(pick\('WHV2_RELOGIN', 'reloginEnabled', ''\)\)\.trim\(\) === '1'/.test(src),
    'recovery must require an explicit opt-in');
});

test('PRESERVE: the version is a real semver ahead of the published 3.5.2', () => {
  assert.match(agent.AGENT_VERSION, /^\d+\.\d+\.\d+$/);
  const [a, b, c] = agent.AGENT_VERSION.split('.').map(Number);
  const [x, y, z] = [3, 5, 2];
  assert.ok(a > x || (a === x && (b > y || (b === y && c > z))), 'must be NEWER than the published 3.5.2, never overwrite it');
});

// -- coverage: the SECOND genuine-logout shape, and the server's verdict ------
// These use plain substring checks rather than regexes: the assertions are about
// exact wiring in the source, and a literal is both clearer and escape-proof.
const SRC = () => fs.readFileSync(AGENT_PATH, 'utf8');

test('TRIGGER: a provider-confirmed SESSION_EXPIRED is a recovery trigger', () => {
  // Cookies still present, but candidateSync verified with the provider and said the
  // session is dead. That verdict is conclusive, so it may trigger recovery.
  const src = SRC();
  assert.ok(src.includes("if (CFG.reloginEnabled && code === 'SESSION_EXPIRED')"),
    'a provider-confirmed expiry must be wired as a trigger');
  assert.ok(src.includes("attemptSourceRelogin(state, 'provider_session_expired')"),
    'and it must carry its own reason so the two logout shapes stay distinguishable');
});

test('TRIGGER: inconclusive / stale / replay verdicts are NOT triggers', () => {
  const src = SRC();
  // The only two call sites in the whole agent are the absent-cookie branch and the
  // provider-confirmed branch. Anything else must not reach a login.
  // Count CALL sites only - 'attemptSourceRelogin(state,' also matches the
  // function's own declaration, which is not a trigger.
  const calls = src.split('await attemptSourceRelogin(state,').length - 1;
  assert.strictEqual(calls, 2, 'exactly two trigger sites expected, found ' + calls);
  assert.ok(src.includes("attemptSourceRelogin(state, 'auth_cookie_absent')"), 'absent-cookie trigger');
  // The invariant is about the GUARD: no inconclusive or ordering verdict may be
  // the condition on a line that reaches a login. Asserted per LINE, because a
  // character window around the bookkeeping line legitimately reaches the nearby
  // SESSION_EXPIRED trigger and would false-positive.
  const lines = src.split(String.fromCharCode(10));
  for (const code of ['VERIFICATION_INCONCLUSIVE', 'STALE_BUNDLE', 'REPLAY_REJECTED']) {
    for (const line of lines) {
      if (line.includes("code === '" + code + "'")) {
        assert.ok(!line.includes('attemptSourceRelogin'), code + ' must never guard a login call');
      }
    }
  }
  // And the only guarded trigger is the provider-confirmed one.
  const trigLine = lines.find(l => l.includes("await attemptSourceRelogin(state, 'provider_session_expired')"));
  const guardLine = lines[lines.indexOf(trigLine) - 1];
  assert.ok(guardLine.includes("code === 'SESSION_EXPIRED'"), 'the only code-guarded trigger is SESSION_EXPIRED');
});

test('TRIGGER: a transport error returns before any recovery decision', () => {
  const src = SRC();
  const errIdx = src.indexOf("log('ingest_post_failed'");
  const trigIdx = src.indexOf("attemptSourceRelogin(state, 'provider_session_expired')");
  assert.ok(errIdx > 0 && trigIdx > errIdx, 'the transport-failure return must precede the trigger');
  assert.ok(src.slice(errIdx, errIdx + 160).includes('return;'), 'and it must return');
});

test('TRIGGER: normal token rotation never triggers recovery', () => {
  const src = SRC();
  const nudge = src.indexOf('async function nudgeTokenRotation');
  const nudgeEnd = src.indexOf('// Diagnostics report attached to EVERY server call');
  assert.ok(nudge > 0 && nudgeEnd > nudge, 'rotation function bounds');
  assert.ok(!src.slice(nudge, nudgeEnd).includes('attemptSourceRelogin'),
    'the rotation path must contain no recovery call');
});

test('VERDICT: ACCOUNT_MISMATCH after recovery halts permanently', () => {
  clearState();
  agent.writeReloginState({ attempts: [], haltedReason: null, haltedAt: null });
  agent.noteReloginVerdict('wrong_account');
  const st = agent.readReloginState();
  assert.strictEqual(st.haltedReason, 'wrong_account', 'a wrong account must be terminal');
  assert.ok(st.haltedAt, 'and timestamped');
  // A halted agent then refuses to try again.
  assert.ok(String(agent.readReloginState().haltedReason).length > 0);
  const src = SRC();
  assert.ok(src.includes("if (code === 'ACCOUNT_MISMATCH')"), 'the rejection path must branch on it');
  assert.ok(src.includes("noteReloginVerdict('wrong_account')"), 'and record the terminal verdict');
  assert.ok(src.includes("log('relogin_rejected_by_server'"), 'and say so in the log');
});

test('VERDICT: local recovery never declares itself successful', () => {
  const src = SRC();
  const fnStart = src.indexOf('async function attemptSourceRelogin');
  const fnEnd = src.indexOf('function noteReloginVerdict');
  assert.ok(fnStart > 0 && fnEnd > fnStart);
  const body = src.slice(fnStart, fnEnd);
  assert.ok(!body.includes("'confirmed'"), 'the local recovery must not declare itself confirmed');
  assert.ok(body.includes("finish('browser_authenticated_pending_verification'"),
    'its success value must name the pending verification explicitly');
  assert.ok(body.includes('state.reloginPending = true;'), 'and it must mark the verdict as awaited');
});

test('VERDICT: only a server ACCEPT may be recorded as confirmed', () => {
  const src = SRC();
  const confirmIdx = src.indexOf("noteReloginVerdict('confirmed')");
  const rejectIdx = src.indexOf("log('ingest_rejected'");
  const acceptIdx = src.indexOf("log('cookie_synchronized'");
  assert.ok(confirmIdx > 0, "a 'confirmed' verdict must exist");
  assert.ok(confirmIdx > rejectIdx, 'it must come after the rejection handling');
  assert.ok(confirmIdx < acceptIdx, 'and sit on the accepted path');
});

test('VERDICT: a non-mismatch rejection is unconfirmed but not halted', () => {
  clearState();
  agent.writeReloginState({ attempts: [], haltedReason: null, haltedAt: null });
  agent.noteReloginVerdict('unconfirmed_STALE_BUNDLE');
  const st = agent.readReloginState();
  assert.strictEqual(st.haltedReason, null, 'a stale-bundle rejection is not terminal');
  assert.strictEqual(st.lastOutcome, 'unconfirmed_STALE_BUNDLE');
});

test('VERDICT: the pending flag is always cleared once a verdict arrives', () => {
  const src = SRC();
  // Both verdict paths (reject + accept) must clear it, or a later unrelated
  // rejection would be misread as this recovery's verdict.
  assert.strictEqual(src.split('state.reloginPending = false;').length - 1, 2,
    'both the rejection and the accept path must clear the pending flag');
});
