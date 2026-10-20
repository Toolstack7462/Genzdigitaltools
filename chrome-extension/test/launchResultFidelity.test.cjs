'use strict';
/**
 * A FAILED LAUNCH MUST CARRY ITS REASON TO THE PAGE.
 *
 * Measured on the deployed build (3.9.37): the orchestrator branch of handleOpenTool returned
 *
 *     { success: result.success, method, requiresManualAction, actionableError, tabId }
 *
 * dropping `result.error`. CookieStrategy sets that field ('No cookies to inject',
 * 'Cookie.set returned null', injection errors), and LoginOrchestrator passes it back — but the
 * page never saw it. With `error`, `stage` and `code` all absent, the dashboard computed null,
 * fell back to the literal string 'Extension error', and its own guard correctly refused to show
 * that as an explanation, producing "Could not open tool. Please refresh the dashboard and try
 * again." for every orchestrator failure, whatever the real cause.
 *
 * `actionableError` was forwarded, but it is only populated for two known modes (manual-action and
 * permission), so every other failure arrived anonymous.
 *
 * These run the REAL js/background.js in the packaged-source harness and drive a real
 * GENZ_OPEN_TOOL message, so they exercise the producer/consumer response contract rather than a
 * source string. No real credential values appear anywhere.
 */
const test = require('node:test'), assert = require('node:assert/strict');
const { env, WH, response } = require('./_fullBackgroundHarness.cjs');

const base = 'https://api.genzdigitalstore.com';
const payload = { apiUrl: base, activationToken: 'SYNTHETIC-ACTIVATION' };

// A credentials response that carries BOTH a session bundle and cookie credentials. That is the
// real shape for this tool, and `hasCreds` being true is what routes the open through the
// orchestrator instead of the sessionBundle-only branch.
function routeWithCreds(url) {
  const p = new URL(url).pathname;
  if (p.endsWith('/auth/activate')) return response({ success: true, token: 'AUTH-SYNTHETIC', expiresAt: '2031-01-01T00:00:00Z', user: { id: 'synthetic-client' } });
  if (p.endsWith('/cleanup-manifest')) return response({ ok: true, active: [], revoked: [] });
  if (p.endsWith('/tools')) return response({ success: true, tools: [WH] });
  if (p.endsWith('/versions')) return response({ versions: {} });
  if (p.endsWith('/credentials')) {
    return response({
      success: true,
      tool: WH,
      sessionBundle: { version: 1, cookies: [{ name: 'fixture_session', value: 'FIXTURE-ONLY-NOT-REAL', domain: 'writehuman.ai', secure: true }] },
      credentials: { type: 'cookies', payload: [{ name: 'fixture_session', value: 'FIXTURE-ONLY-NOT-REAL', domain: 'writehuman.ai' }] },
    });
  }
  if (p.endsWith('/opened')) return response({ success: true });
  throw new Error('Unexpected test URL: ' + p);
}

// Replace the cached orchestrator inside the VM with one whose executeLogin we control.
function installOrchestrator(e, impl) {
  e.eval(`orchestrator = { executeLogin: ${impl} };`);
}

// The orchestrator branch awaits waitForTabLoad(tab, 20000), which resolves on a tabs.onUpdated
// 'complete' event. The harness never emits one, so without this every case would sit out the
// full 20s timeout -- 2 minutes added to a 0.7s suite, for no extra coverage. Reporting the tab
// as loaded is what a real browser does. Done deterministically by answering the listener the
// moment it is registered, rather than racing it on a timer.
function autoCompleteTabLoads(e) {
  const up = e.chrome.tabs.onUpdated;
  const add = up.addListener.bind(up);
  up.addListener = (fn) => {
    add(fn);
    setTimeout(() => fn(1, { status: 'complete' }, { id: 1, url: 'https://writehuman.ai/' }), 0);
  };
}

async function connectAndOpen(e) {
  autoCompleteTabLoads(e);
  const connected = await e.message({ type: 'GENZ_CONNECT_EXTENSION', payload });
  assert.equal(connected.connected, true, 'fixture must connect first');
  return e.message({ type: 'GENZ_OPEN_TOOL', payload: { toolId: WH.id } });
}

test('an orchestrator failure reaches the page WITH its reason', async (t) => {
  const e = env({ storage: { extensionToken: null }, permission: true, fetch: routeWithCreds });
  t.after(e.close);
  installOrchestrator(e, `async () => ({ success: false, method: 'cookies', error: 'cookie_injection_failed' })`);
  const out = await connectAndOpen(e);
  assert.equal(out.success, false, JSON.stringify(out));
  assert.equal(out.error, 'cookie_injection_failed',
    'the page must receive the producer\'s reason, not an anonymous failure: ' + JSON.stringify(out));
});

test('a failure does NOT fabricate an actionableError it was never given', async (t) => {
  const e = env({ storage: { extensionToken: null }, permission: true, fetch: routeWithCreds });
  t.after(e.close);
  installOrchestrator(e, `async () => ({ success: false, method: 'cookies', error: 'cookie_injection_failed' })`);
  const out = await connectAndOpen(e);
  // Only manual-action and permission failures get a human sentence; this one must stay honest.
  assert.equal(out.actionableError, null, JSON.stringify(out));
});

test('a manual-action failure still gets its human sentence, and keeps the raw reason too', async (t) => {
  const e = env({ storage: { extensionToken: null }, permission: true, fetch: routeWithCreds });
  t.after(e.close);
  installOrchestrator(e, `async () => ({ success: false, method: 'cookies', error: 'challenge_detected', requiresManualAction: true })`);
  const out = await connectAndOpen(e);
  assert.equal(out.success, false);
  assert.match(String(out.actionableError), /MFA, CAPTCHA, or Cloudflare/);
  assert.equal(out.error, 'challenge_detected', 'the specific reason must survive alongside the sentence');
});

test('a thrown orchestrator error still reaches the page', async (t) => {
  const e = env({ storage: { extensionToken: null }, permission: true, fetch: routeWithCreds });
  t.after(e.close);
  installOrchestrator(e, `async () => { throw new Error('executeLogin exploded'); }`);
  const out = await connectAndOpen(e);
  assert.equal(out.success, false);
  assert.equal(out.error, 'executeLogin exploded');
});

test('a SUCCESSFUL orchestrator launch is unchanged and reports no error', async (t) => {
  const e = env({ storage: { extensionToken: null }, permission: true, fetch: routeWithCreds });
  t.after(e.close);
  installOrchestrator(e, `async () => ({ success: true, method: 'cookies' })`);
  const out = await connectAndOpen(e);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.method, 'cookies');
  assert.ok(!out.error, 'a success must not carry an error field: ' + JSON.stringify(out));
  // the success path reports the open to the backend
  assert.ok(e.calls.network.some((c) => c.url.endsWith('/opened')), 'a confirmed open must be logged');
});

test('no fixture credential value leaks into the response or the logs', async (t) => {
  const e = env({ storage: { extensionToken: null }, permission: true, fetch: routeWithCreds });
  t.after(e.close);
  installOrchestrator(e, `async () => ({ success: false, error: 'cookie_injection_failed' })`);
  const out = await connectAndOpen(e);
  assert.equal(JSON.stringify(out).includes('FIXTURE-ONLY-NOT-REAL'), false);
  assert.equal(JSON.stringify(e.calls.logs).includes('FIXTURE-ONLY-NOT-REAL'), false);
});

// ── POST-LAUNCH TASKS MUST NEVER FAIL A COMPLETED OPEN ────────────────────────────────────────
// The operator reported "WriteHuman opened correctly, but the dashboard still showed the red
// failure", so every awaited task that runs AFTER the session is applied was audited for whether
// it can turn a finished open into a reported failure. Two were candidates:
//
//   logToolOpened()  — POSTs /tools/:id/opened (audit telemetry: CredentialAccessLog TOOL_OPENED
//                      + ActivityLog + presence). It is NOT an authorization gate; access was
//                      already enforced at the credential fetch.
//   setSessionCache() — the fast-open cache. Pure performance, no security role.
//
// Both already swallow their own errors, so neither is the cause. These tests pin that, because
// the property is invisible in the happy path and a future edit could silently remove it — and
// the audit call itself must stay (it is not removed, only made unable to break the launch).
test('a FAILED audit POST does not turn a completed open into a failure', async (t) => {
  const e = env({
    storage: { extensionToken: null }, permission: true,
    fetch: (url, init) => {
      const p = new URL(url).pathname;
      if (p.endsWith('/opened')) return response({ error: 'audit sink down' }, 500);
      return routeWithCreds(url, init);
    },
  });
  t.after(e.close);
  installOrchestrator(e, `async () => ({ success: true, method: 'cookies' })`);
  const out = await connectAndOpen(e);
  assert.equal(out.success, true, 'telemetry is not a launch prerequisite: ' + JSON.stringify(out));
  assert.ok(e.calls.network.some((c) => c.url.endsWith('/opened')), 'the audit call must still be ATTEMPTED');
});

test('a FAILING storage write (session cache) does not turn a completed open into a failure', async (t) => {
  const e = env({
    storage: { extensionToken: null }, permission: true, fetch: routeWithCreds,
    // Fail exactly the fast-open cache write, nothing else.
    writeError: (data) => (Object.keys(data).some((k) => k.startsWith('genzSessionCache')) ? 'QUOTA_BYTES exceeded' : null),
  });
  t.after(e.close);
  installOrchestrator(e, `async () => ({ success: true, method: 'cookies' })`);
  const out = await connectAndOpen(e);
  assert.equal(out.success, true, 'an optional cache write must not fail the launch: ' + JSON.stringify(out));
});

test('a duplicate click is reported as already_opening, never as a red failure reason', async (t) => {
  const e = env({ storage: { extensionToken: null }, permission: true, fetch: routeWithCreds });
  t.after(e.close);
  autoCompleteTabLoads(e);
  const connected = await e.message({ type: 'GENZ_CONNECT_EXTENSION', payload });
  assert.equal(connected.connected, true);
  installOrchestrator(e, `async () => { await new Promise(r => setTimeout(r, 30)); return { success: true, method: 'cookies' }; }`);
  const [a, b] = await Promise.all([
    e.message({ type: 'GENZ_OPEN_TOOL', payload: { toolId: WH.id } }),
    e.message({ type: 'GENZ_OPEN_TOOL', payload: { toolId: WH.id } }),
  ]);
  const outs = [a, b];
  assert.equal(outs.filter((o) => o.success === true).length, 1, 'exactly one intended open');
  const dup = outs.find((o) => o.success !== true);
  assert.equal(dup.error, 'already_opening', 'the duplicate must be identifiable, not a generic failure');
});
