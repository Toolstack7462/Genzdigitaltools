'use strict';
/**
 * WriteHuman V2 — Cookie Sync Agent (runs on the dedicated RDP, next to the 24/7 Chrome).
 *
 * Connects to the always-on Chrome via the Chrome DevTools Protocol (CDP), reads the browser
 * cookies (Storage.getCookies on the browser target), keeps ONLY the WriteHuman auth cookies
 * (`sb-<ref>-auth-token` + chunks, `sb-session-token`), hashes them, and — only when the hash
 * CHANGES — pushes them to the V2 service (`POST /v2/cookies/ingest`). The server then
 * replaces (never merges) the stored auth cookies, auto-verifies, and resets its smart timer.
 *
 * Dependency-free: uses Node's global `fetch` (>=18) and global `WebSocket` (>=22). Never logs
 * cookie values — counts and an 8-char hash prefix only. Lightweight: one infrequent poll, one
 * short-lived CDP connection per poll, errors are caught and retried on the next tick (no tight
 * loop, no crash).
 *
 * Launch the 24/7 Chrome with, e.g.:
 *   chrome.exe --user-data-dir="C:\\wh-profile" --remote-debugging-port=9222
 * then run:  node agent/cookie-sync-agent.js
 *
 * Env:
 *   WHV2_INGEST_URL   default http://127.0.0.1:3100/v2/cookies/ingest
 *   WHV2_AGENT_KEY    required (matches WRITEHUMAN_V2_AGENT_KEY or _ADMIN_KEY on the server)
 *   WHV2_CDP_URL      default http://127.0.0.1:9222
 *   WHV2_TARGET_DOMAIN default writehuman.ai
 *   WHV2_SUPABASE_REF default hicfsbrfkzsxbwayibfm
 *   WHV2_POLL_MS      default 120000 (2 min)
 *   WHV2_CHROME_TASK  default WriteHumanChromeDebug (scheduled task used for relaunch-chrome)
 */
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const AGENT_VERSION = '3.0.0';

// Single-source config: an optional config.json (non-secret settings, shared with the watchdog) is
// read as a fallback; ENV always takes precedence, so a service manager / run-agent.cmd can override.
// The AGENT KEY is read from ENV or a locked-down key FILE (WHV2_AGENT_KEY_FILE) — never from the
// shared config.json — so the secret isn't sitting in a world-readable launcher/config.
function readJsonFile(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function readKeyFile(p) { if (!p) return ''; try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; } }
const CONFIG_PATH = process.env.WHV2_CONFIG || path.join(__dirname, '..', 'config.json');
const FILE_CFG = readJsonFile(CONFIG_PATH) || {};
const CONFIG_SOURCE = readJsonFile(CONFIG_PATH) ? CONFIG_PATH : 'env-only';
function pick(env, fileKey, dflt) {
  const e = process.env[env];
  if (e != null && e !== '') return e;
  if (FILE_CFG[fileKey] != null) return String(FILE_CFG[fileKey]);
  return dflt;
}

const CFG = {
  ingestUrl: pick('WHV2_INGEST_URL', 'ingestUrl', 'http://127.0.0.1:3100/v2/cookies/ingest'),
  agentKey: process.env.WHV2_AGENT_KEY || readKeyFile(process.env.WHV2_AGENT_KEY_FILE) || readKeyFile(FILE_CFG.agentKeyFile) || '',
  cdpUrl: pick('WHV2_CDP_URL', 'cdpUrl', 'http://127.0.0.1:9222').replace(/\/$/, ''),
  domain: pick('WHV2_TARGET_DOMAIN', 'domain', 'writehuman.ai'),
  ref: pick('WHV2_SUPABASE_REF', 'ref', 'hicfsbrfkzsxbwayibfm'),
  pollMs: Math.max(15000, parseInt(pick('WHV2_POLL_MS', 'pollMs', ''), 10) || 120000),
  // Consecutive empty (no-auth) polls before we treat it as a real logout and signal V2.
  logoutDebounce: Math.max(1, parseInt(pick('WHV2_LOGOUT_DEBOUNCE', 'logoutDebounce', ''), 10) || 2),
  // The scheduled task that (re)launches the debug Chrome IN THE INTERACTIVE USER SESSION. The
  // agent runs as SYSTEM (session 0), so relaunch must go through this task, never a direct spawn.
  chromeTask: pick('WHV2_CHROME_TASK', 'chromeTask', 'WriteHumanChromeDebug'),
  // Auto-recovery: relaunch Chrome after this many consecutive CDP failures (faster than the 5-min
  // watchdog), rate-limited by a cooldown so it never relaunch-spams.
  cdpRelaunchAfter: Math.max(1, parseInt(pick('WHV2_CDP_RELAUNCH_AFTER', 'cdpRelaunchAfter', ''), 10) || 3),
  relaunchCooldownMs: Math.max(30000, parseInt(pick('WHV2_RELAUNCH_COOLDOWN_MS', 'relaunchCooldownMs', ''), 10) || 120000),
  // Backoff cap when the backend is unreachable (poll delay grows exponentially, then recovers).
  maxBackoffMs: Math.max(60000, parseInt(pick('WHV2_MAX_BACKOFF_MS', 'maxBackoffMs', ''), 10) || 300000),
  // Single-instance lock FILE (PID + heartbeat). See acquireLock(): a dedicated file can't be
  // blocked by an unrelated process (unlike a shared port), and the heartbeat lets us tell a LIVE
  // duplicate from a stale/crashed/PID-reused lock and take the latter over.
  lockFile: process.env.WHV2_LOCK_FILE || FILE_CFG.lockFile || path.join(__dirname, '..', 'agent.lock'),
  // ── multi-device identity ──────────────────────────────────────────────────
  // This machine's own pairing. The device id + key are obtained ONCE by redeeming a single-use
  // pairing code from the admin panel, then persisted here. Several machines can be paired at the
  // same time; the server promotes whichever supplies the newest VERIFIED bundle, so moving the
  // login between them needs no configuration change on either side.
  deviceStateFile: process.env.WHV2_DEVICE_STATE || FILE_CFG.deviceStateFile || path.join(__dirname, '..', 'agent-device.json'),
  pairCode: process.env.WHV2_PAIR_CODE || '',
  deviceName: pick('WHV2_DEVICE_NAME', 'deviceName', os.hostname()),
  // After a cookie CHANGE, poll faster for a short window: a Supabase rotation is usually followed
  // by more activity, and this catches the follow-up promptly without ever becoming busy-polling.
  quickPollMs: Math.max(5000, parseInt(pick('WHV2_QUICK_POLL_MS', 'quickPollMs', ''), 10) || 15000),
  quickPollFor: Math.max(0, parseInt(pick('WHV2_QUICK_POLL_COUNT', 'quickPollFor', ''), 10) || 4),
};

// ── device state (deviceId + deviceKey + monotonic seq) ──────────────────────
// Kept OUT of the shared config.json: it holds this machine's secret. Written with an owner-only
// mode; on Windows the ACL is applied by the provisioning script.
function loadDeviceState() {
  try {
    const s = JSON.parse(fs.readFileSync(CFG.deviceStateFile, 'utf8'));
    if (s && s.deviceId && s.deviceKey) return { deviceId: s.deviceId, deviceKey: s.deviceKey, seq: Number(s.seq) || 0, name: s.name || null };
  } catch (_) { /* not paired yet */ }
  return null;
}
function saveDeviceState(st) {
  try {
    fs.writeFileSync(CFG.deviceStateFile, JSON.stringify(st, null, 2), { mode: 0o600 });
    return true;
  } catch (e) { log('device_state_write_failed', { error: e.message }); return false; }
}
/** The pairing endpoint that matches the configured ingest URL (…/cookies -> …/pair). */
function pairUrl() { return CFG.ingestUrl.replace(/\/cookies\/?$/, '/pair'); }

/**
 * Redeem a single-use pairing code, once, and persist the resulting device identity.
 * Never logs the code or the returned key.
 */
async function pairDevice(code) {
  const url = pairUrl();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, hostname: os.hostname(), agentVersion: AGENT_VERSION }),
    signal: AbortSignal.timeout(20000),
  });
  let body = null; try { body = await resp.json(); } catch (_) {}
  if (!resp.ok || !body || !body.deviceKey) {
    log('pairing_failed', { status: resp.status, code: (body && body.code) || null });
    return null;
  }
  const st = { deviceId: body.deviceId, deviceKey: body.deviceKey, name: body.name || CFG.deviceName, seq: 0 };
  if (!saveDeviceState(st)) return null;
  log('paired', { device_id: st.deviceId, name: st.name });
  return st;
}

// Structured, timestamped log line (ISO 8601). Never logs cookie values — counts / 8-char hash only.
function log(event, fields) { try { console.log(`[${new Date().toISOString()}] [wh-v2-agent] ${event} ${JSON.stringify(fields || {})}`); } catch (_) {} }

// Sticky error tracker. Unlike the momentary per-poll `state.lastError`, these PERSIST across
// recovery so the dashboard can show "last error … Xm ago (N×)" instead of a field that snaps back
// to "none" on the next good poll. errorCount is cumulative since this agent instance started.
function recordError(state, msg) {
  state.errorCount = (state.errorCount || 0) + 1;
  state.lastErrorMsg = msg ? String(msg).slice(0, 200) : 'error';
  state.lastErrorAt = Date.now();
}

// ── pure helpers (exported for tests) ─────────────────────────────────────────
function authTokenBase(ref) { return 'sb-' + ref + '-auth-token'; }
function isAuthName(name, ref) {
  if (!name) return false;
  const base = authTokenBase(ref);
  return name === base || name.startsWith(base + '.') || name === 'sb-session-token';
}
function domainMatches(cookieDomain, domain) {
  const cd = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  if (!cd) return true;
  return cd === d || cd.endsWith('.' + d) || d.endsWith('.' + cd);
}
// Keep only the auth cookies for the target domain, as { name, value, domain, path }.
function filterAuthCookies(cookies, domain, ref) {
  return (cookies || [])
    .filter((c) => c && isAuthName(c.name, ref) && domainMatches(c.domain, domain))
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/' }));
}
// MUST match session/cookieManager.cookieHash: sha256 of sorted "name=value" joined by \n.
function hashAuthCookies(authList) {
  const items = (authList || []).map((c) => `${c.name}=${c.value == null ? '' : c.value}`).sort();
  if (!items.length) return null;
  return crypto.createHash('sha256').update(items.join('\n')).digest('hex');
}

// ── CDP: read all browser cookies via Storage.getCookies ──────────────────────
async function getAllCookiesViaCDP(cdpUrl) {
  const verRes = await fetch(cdpUrl + '/json/version', { signal: AbortSignal.timeout(8000) });
  if (!verRes.ok) throw new Error('cdp_version_http_' + verRes.status);
  const ver = await verRes.json();
  const wsUrl = ver.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('cdp_no_ws_url');
  if (typeof WebSocket === 'undefined') throw new Error('no_global_websocket_need_node22');

  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(t); try { ws.close(); } catch (_) {} fn(arg); };
    const t = setTimeout(() => done(reject, new Error('cdp_timeout')), 10000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })); } catch (e) { done(reject, e); } };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.id === 1) {
          if (msg.error) return done(reject, new Error('cdp_' + (msg.error.message || 'error')));
          done(resolve, (msg.result && msg.result.cookies) || []);
        }
      } catch (_) { /* ignore non-JSON / other events */ }
    };
    ws.onerror = () => done(reject, new Error('cdp_ws_error'));
    ws.onclose = () => { if (!settled) done(reject, new Error('cdp_ws_closed')); };
  });
}

// Diagnostics report attached to EVERY server call (drives the dashboard).
function buildReport(state) {
  return {
    cdp: state.cdp, chrome: state.chrome, pollCount: state.pollCount,
    authCookies: state.authCount,
    // Sticky last error (persists across recovery) + when + cumulative count since start.
    lastError: state.lastErrorMsg || null,
    lastErrorAt: state.lastErrorAt ? new Date(state.lastErrorAt).toISOString() : null,
    errorCount: state.errorCount || 0,
    host: os.hostname(), version: AGENT_VERSION,
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    lastCommand: state.lastCommand || null,
    lastCommandAt: state.lastCommandAt ? new Date(state.lastCommandAt).toISOString() : null,
  };
}

// One POST to /v2/cookies/ingest (cookie push / heartbeat / logout), always carrying the agent
// report. Executes any command the server hands back. Returns the parsed body, or {_err}/{_status}.
async function postToServer(state, payload) {
  let resp;
  // Per-device identity + a monotonic sequence. The sequence is the server's replay guard: a push
  // whose seq is not greater than the last one it accepted from THIS device is refused, so a
  // re-sent or duplicated request can never re-apply an older bundle. The idempotency key lets a
  // retry of the SAME request (a lost ack, not a new state) be recognised and answered from the
  // previous outcome instead of being applied twice.
  const dev = state.device || null;
  const headers = { 'content-type': 'application/json', 'x-agent-key': (dev && dev.deviceKey) || CFG.agentKey };
  if (dev && dev.deviceId) headers['x-device-id'] = dev.deviceId;
  const envelope = Object.assign({ agent: buildReport(state) }, payload);
  if (dev) {
    dev.seq = (dev.seq || 0) + 1;
    envelope.seq = dev.seq;
    envelope.idempotencyKey = dev.deviceId + ':' + dev.seq;
    saveDeviceState(dev);
  }
  try {
    resp = await fetch(CFG.ingestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope),
      // 20s: a cookie push triggers a server-side verify, and the FIRST request after a Passenger
      // reload is slow (cold start). 10s occasionally aborted -> ingest_post_failed{timeout}; the
      // write still landed but the ack was lost. 20s absorbs cold starts; steady posts are fast.
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { state.ingestFails = (state.ingestFails || 0) + 1; recordError(state, 'post_failed: ' + e.message); return { _err: e.message }; }
  let body = null; try { body = await resp.json(); } catch (_) {}
  if (resp.ok) {
    state.ingestFails = 0;                                    // reachable again -> clear backoff
    if (body && body.command) handleCommand(state, body.command);
    return body || {};
  }
  // A 4xx is the server ANSWERING us — the candidate was judged and refused (stale, wrong account,
  // replayed). That is not unreachability, so it must not drive the backoff that exists to stop us
  // hammering a down backend; treating a healthy "your bundle is older than the active one" as an
  // outage would back the agent off to 5-minute polls for no reason.
  if (resp.status >= 500 || resp.status === 429) state.ingestFails = (state.ingestFails || 0) + 1;
  recordError(state, 'ingest_http_' + resp.status + ((body && body.code) ? ' ' + body.code : ''));
  return { _status: resp.status, body, code: body && body.code };
}

// Execute a whitelisted remote command from the dashboard. Best-effort; never throws.
function handleCommand(state, cmd) {
  try {
    state.lastCommand = cmd; state.lastCommandAt = Date.now();
    if (cmd === 'reverify') {
      // Force a real re-sync + server-side re-verify on the next poll: clear lastHash AND set the
      // force flag so the push is honoured even if the cookie hash is unchanged (the server no-ops
      // an unchanged hash otherwise, which made "Re-sync" a silent no-op).
      state.lastHash = null; state.forceNext = true; log('command_reverify', {}); return;
    }
    if (cmd === 'relaunch-chrome') {
      // Run the ChromeDebug SCHEDULED TASK (registered in the interactive user session). The agent
      // runs as SYSTEM (session 0) — a direct chrome spawn would launch invisibly in session 0 and
      // collide with the user-session profile lock, so it must go through the task.
      log('command_relaunch_chrome', { task: CFG.chromeTask });
      const p = spawn('schtasks', ['/run', '/tn', CFG.chromeTask], { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', (e) => log('command_relaunch_failed', { error: e.message }));
      p.unref();
      return;
    }
    log('command_unknown', { command: cmd });
  } catch (e) { log('command_failed', { command: cmd, error: e.message }); }
}

async function pushIfChanged(state) {
  state.pollCount = (state.pollCount || 0) + 1;
  let cookies;
  try {
    cookies = await getAllCookiesViaCDP(CFG.cdpUrl);
    state.cdp = '200'; state.chrome = true; state.lastError = null; state.cdpFails = 0;
  } catch (e) {
    state.cdp = 'DOWN'; state.chrome = false; state.lastError = e.message;
    state.cdpFails = (state.cdpFails || 0) + 1;
    recordError(state, 'cdp: ' + e.message);
    log('cdp_read_failed', { error: e.message, consecutive: state.cdpFails });
    // AUTO-RECOVERY: after N consecutive CDP failures the debug Chrome is likely dead/closed —
    // relaunch it via its task (faster than the 5-min watchdog). Cooldown-gated so it can't
    // relaunch-spam while Chrome is still coming back up.
    if (state.cdpFails >= CFG.cdpRelaunchAfter && (Date.now() - (state.lastRelaunchAt || 0)) > CFG.relaunchCooldownMs) {
      state.lastRelaunchAt = Date.now();
      log('cdp_auto_relaunch', { after_fails: state.cdpFails, task: CFG.chromeTask });
      try { const p = spawn('schtasks', ['/run', '/tn', CFG.chromeTask], { detached: true, stdio: 'ignore', windowsHide: true }); p.on('error', (er) => log('cdp_auto_relaunch_failed', { error: er.message })); p.unref(); } catch (_) {}
    }
    await postToServer(state, { heartbeat: true, hash: null }); // report CDP-down so the dashboard sees it live
    return;
  }
  const auth = filterAuthCookies(cookies, CFG.domain, CFG.ref);
  state.authCount = auth.length;
  const hash = hashAuthCookies(auth);
  if (!hash) {
    if (state.lastHash !== null) {
      state.emptyPolls = (state.emptyPolls || 0) + 1;
      if (state.emptyPolls >= CFG.logoutDebounce && !state.loggedOutSent) {
        const r = await postToServer(state, { loggedOut: true, reason: 'auth_cookie_absent' });
        if (r && !r._err && r._status == null) { state.loggedOutSent = true; log('logout_signaled', { after_polls: state.emptyPolls }); }
      } else {
        await postToServer(state, { heartbeat: true, hash: null });
        log('browser_not_authenticated', { auth_cookies: 0, empty_polls: state.emptyPolls });
      }
    } else {
      await postToServer(state, { heartbeat: true, hash: null });
      log('browser_not_authenticated', { auth_cookies: 0 });
    }
    return;
  }
  state.emptyPolls = 0; state.loggedOutSent = false;
  const forced = !!state.forceNext;
  if (!forced && hash === state.lastHash) {
    const r = await postToServer(state, { heartbeat: true, hash: hash.slice(0, 8) });
    if (r && r._err) log('heartbeat_failed', { error: r._err });
    else if (r && r._status) log('heartbeat_rejected', { status: r._status });
    else log('heartbeat', { hash: hash.slice(0, 8) });
    return;
  }
  const r = await postToServer(state, forced ? { cookies: auth, force: true } : { cookies: auth });
  if (r && r._err) { log('ingest_post_failed', { error: r._err }); return; }     // keep lastHash + forceNext → retry next tick
  if (r && r._status) {
    // A REFUSED candidate is a real outcome, not a transport failure: record the server's reason
    // and stop re-offering the same bundle, or the agent would push a rejected candidate forever.
    // STALE_BUNDLE in particular is normal and healthy — it just means another device is ahead.
    const code = (r.body && r.body.code) || r.code || null;
    if (code === 'STALE_BUNDLE' || code === 'ACCOUNT_MISMATCH' || code === 'REPLAY_REJECTED') state.lastHash = hash;
    log('ingest_rejected', { status: r._status, code });
    return;
  }
  state.lastHash = hash; state.forceNext = false;
  // A genuine change happened — poll faster for a short window to catch the follow-up rotation.
  state.quickPollsLeft = CFG.quickPollFor;
  log('cookie_synchronized', {
    hash: hash.slice(0, 8), changed: r.changed, result: r.code || r.result, forced,
    promoted: r.promoted === true, source_switched: r.sourceSwitched === true,
    active_source: (r.activeSource && r.activeSource.name) || null,
    is_active_source: r.isActiveSource === true,
  });
}

// ── single-instance lock (PID + heartbeat file) ───────────────────────────────
// A dedicated lock FILE (not a shared port) so an unrelated process can never block us, and a
// heartbeat timestamp so we can distinguish a LIVE duplicate (PID alive AND recently refreshed ->
// we exit) from a stale lock (crashed / wedged / PID reused -> we take it over). The running agent
// refreshes it every poll; releaseLock only ever removes OUR OWN lock.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }   // signal 0 = existence probe, never kills
  catch (e) { return e.code === 'EPERM'; }      // EPERM = exists but owned by another user
}
function lockStaleMs() { return Math.max(3 * CFG.pollMs, 90000); }
function lockPayload() { return JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }); }
function refreshLock() { try { fs.writeFileSync(CFG.lockFile, lockPayload()); } catch (_) { /* best-effort heartbeat */ } }
function releaseLock() {
  try { const cur = JSON.parse(fs.readFileSync(CFG.lockFile, 'utf8')); if (cur && cur.pid === process.pid) fs.unlinkSync(CFG.lockFile); }
  catch (_) { /* not ours / already gone */ }
}
// true = we hold the lock; false = a live agent already holds it.
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(CFG.lockFile, 'wx');   // atomic create — only one racer wins
      fs.writeSync(fd, lockPayload()); fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') { log('lock_error', { error: e.message, note: 'proceeding without file lock' }); return true; }
      let holder = 0, ageMs = Infinity;
      try {
        const cur = JSON.parse(fs.readFileSync(CFG.lockFile, 'utf8'));
        holder = parseInt(cur && cur.pid, 10) || 0;
        const at = cur && Date.parse(cur.at);
        ageMs = Number.isFinite(at) ? (Date.now() - at) : (Date.now() - fs.statSync(CFG.lockFile).mtimeMs);
      } catch (_) { try { ageMs = Date.now() - fs.statSync(CFG.lockFile).mtimeMs; } catch (_) {} }
      // Live duplicate: known holder, PID alive, and the heartbeat is fresh.
      if (holder && holder !== process.pid && pidAlive(holder) && ageMs < lockStaleMs()) return false;
      // Unknown holder but the lock was written a heartbeat ago (a racing starter mid-write): defer.
      if (!holder && ageMs < 5000) return false;
      try { fs.unlinkSync(CFG.lockFile); } catch (_) {}   // stale (dead/old/corrupt) -> clear + retry
    }
  }
  return false;
}

// Acquire the single-instance lock, then hand off to run(). A duplicate is not an error (it's
// correctly refused), so we exit 0 — the supervisor won't flap-restart on a benign double-launch.
function start() {
  if (!acquireLock()) {
    log('singleton_conflict', { lock_file: CFG.lockFile, note: 'another agent holds the lock — exiting' });
    process.exit(0);
  }
  process.on('exit', releaseLock);   // sync cleanup on any exit; only removes our own lock
  // run() is async (it may redeem a pairing code before the first poll). An unhandled rejection
  // here would leave the lock held by a process that never polls, so failures exit explicitly and
  // let the supervisor restart us.
  run().catch((e) => { log('fatal', { reason: 'startup failed', error: e && e.message }); process.exit(1); });
}

async function run() {
  // Identity resolution, in order: an existing pairing on this machine, else redeem a pairing code
  // if one was supplied, else fall back to the pre-multi-device single global key.
  let device = loadDeviceState();
  if (!device && CFG.pairCode) {
    try { device = await pairDevice(CFG.pairCode); } catch (e) { log('pairing_error', { error: e.message }); }
  }
  if (!device && !CFG.agentKey) {
    const kf = process.env.WHV2_AGENT_KEY_FILE || FILE_CFG.agentKeyFile;
    log('fatal', {
      reason: kf ? 'agent key file configured but empty/unreadable' : 'this device is not paired and no agent key is configured',
      remedy: 'Create a pairing code in Admin -> WriteHuman -> Devices, then start the agent once with WHV2_PAIR_CODE=<code>',
      key_file: kf || null, device_state: CFG.deviceStateFile,
    });
    process.exit(1);
  }
  if (!/^https:/i.test(CFG.ingestUrl) && !/(127\.0\.0\.1|localhost)/i.test(CFG.ingestUrl)) {
    log('warn_insecure_ingest', { note: 'ingest URL is not https — the device key would travel in cleartext' });
  }
  const keySource = device ? 'device' : (process.env.WHV2_AGENT_KEY ? 'env' : 'file');
  log('starting', { version: AGENT_VERSION, ingest: CFG.ingestUrl, cdp: CFG.cdpUrl, domain: CFG.domain, poll_ms: CFG.pollMs, chrome_task: CFG.chromeTask, config: CONFIG_SOURCE, key_source: keySource, lock_file: CFG.lockFile, device_id: device ? device.deviceId : null, device_name: device ? device.name : null });

  const state = { device, lastHash: null, startedAt: Date.now(), pollCount: 0, authCount: 0, cdp: null, chrome: false, lastError: null, errorCount: 0, lastErrorMsg: null, lastErrorAt: null, emptyPolls: 0, loggedOutSent: false, forceNext: false, stopped: false, cdpFails: 0, ingestFails: 0, lastRelaunchAt: 0, lastDelay: 0, quickPollsLeft: 0 };
  let timer = null;
  // Self-rescheduling timer: AWAIT each poll before scheduling the next, so polls never overlap
  // (a slow CDP read + ingest can exceed the poll interval). NOT unref'd — the agent is a daemon,
  // so this timer is what keeps the process alive; shutdown() clears it + exits explicitly.
  // Exponential backoff when the backend is unreachable (consecutive ingest failures) so a down
  // backend isn't hammered every poll; snaps back to the base interval on the first success.
  const schedule = () => {
    if (state.stopped) return;
    const fails = state.ingestFails || 0;
    // Backoff beats everything; otherwise a recent cookie change buys a short burst of faster
    // polling (bounded by quickPollFor) so a rotation is picked up in seconds rather than minutes,
    // then it settles straight back to the low-frequency reconciliation interval.
    let delay = CFG.pollMs;
    if (fails > 0) delay = Math.min(CFG.maxBackoffMs, CFG.pollMs * Math.min(2 ** fails, 8));
    else if (state.quickPollsLeft > 0) { delay = CFG.quickPollMs; state.quickPollsLeft -= 1; }
    if (delay !== CFG.pollMs && delay !== state.lastDelay) log('backoff', { next_ms: delay, ingest_fails: fails });
    state.lastDelay = delay;
    timer = setTimeout(loop, delay);
  };
  const loop = async () => {
    refreshLock();   // heartbeat the lock each poll so a stale/crashed lock is detectable by the next starter
    try { await pushIfChanged(state); } catch (e) { log('tick_error', { error: e && e.message }); }
    schedule();
  };

  const shutdown = () => { state.stopped = true; if (timer) clearTimeout(timer); releaseLock(); log('stopping', {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Fail-fast on an unknown-state crash so the supervisor (task/watchdog/NSSM) restarts clean;
  // a stray promise rejection is logged and tolerated (the next poll recovers).
  process.on('uncaughtException', (e) => { log('uncaught_exception', { error: e && e.message }); process.exit(1); });
  process.on('unhandledRejection', (e) => { log('unhandled_rejection', { error: (e && e.message) || String(e) }); });

  loop(); // run once immediately, then self-reschedule
}

module.exports = { isAuthName, domainMatches, filterAuthCookies, hashAuthCookies, getAllCookiesViaCDP, buildReport, AGENT_VERSION, CFG };

if (require.main === module) start();
