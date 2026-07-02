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

const AGENT_VERSION = '2.4.0';

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
};

// Structured, timestamped log line (ISO 8601). Never logs cookie values — counts / 8-char hash only.
function log(event, fields) { try { console.log(`[${new Date().toISOString()}] [wh-v2-agent] ${event} ${JSON.stringify(fields || {})}`); } catch (_) {} }

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
    authCookies: state.authCount, lastError: state.lastError,
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
  try {
    resp = await fetch(CFG.ingestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-key': CFG.agentKey },
      body: JSON.stringify(Object.assign({ agent: buildReport(state) }, payload)),
      // 20s: a cookie push triggers a server-side verify, and the FIRST request after a Passenger
      // reload is slow (cold start). 10s occasionally aborted -> ingest_post_failed{timeout}; the
      // write still landed but the ack was lost. 20s absorbs cold starts; steady posts are fast.
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { state.ingestFails = (state.ingestFails || 0) + 1; return { _err: e.message }; }
  let body = null; try { body = await resp.json(); } catch (_) {}
  if (resp.ok) {
    state.ingestFails = 0;                                    // reachable again -> clear backoff
    if (body && body.command) handleCommand(state, body.command);
    return body || {};
  }
  state.ingestFails = (state.ingestFails || 0) + 1;
  return { _status: resp.status };
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
  if (r && r._status) { log('ingest_rejected', { status: r._status }); return; }
  state.lastHash = hash; state.forceNext = false;
  log('cookie_synchronized', { hash: hash.slice(0, 8), changed: r.changed, result: r.result, forced });
}

function start() {
  if (!CFG.agentKey) { log('fatal', { reason: 'WHV2_AGENT_KEY not set' }); process.exit(1); }
  if (!/^https:/i.test(CFG.ingestUrl) && !/(127\.0\.0\.1|localhost)/i.test(CFG.ingestUrl)) {
    log('warn_insecure_ingest', { note: 'ingest URL is not https — the agent key would travel in cleartext' });
  }
  const keySource = process.env.WHV2_AGENT_KEY ? 'env' : ((process.env.WHV2_AGENT_KEY_FILE || FILE_CFG.agentKeyFile) ? 'file' : 'none');
  log('starting', { version: AGENT_VERSION, ingest: CFG.ingestUrl, cdp: CFG.cdpUrl, domain: CFG.domain, poll_ms: CFG.pollMs, chrome_task: CFG.chromeTask, config: CONFIG_SOURCE, key_source: keySource });

  const state = { lastHash: null, startedAt: Date.now(), pollCount: 0, authCount: 0, cdp: null, chrome: false, lastError: null, emptyPolls: 0, loggedOutSent: false, forceNext: false, stopped: false, cdpFails: 0, ingestFails: 0, lastRelaunchAt: 0, lastDelay: 0 };
  let timer = null;
  // Self-rescheduling timer: AWAIT each poll before scheduling the next, so polls never overlap
  // (a slow CDP read + ingest can exceed the poll interval). NOT unref'd — the agent is a daemon,
  // so this timer is what keeps the process alive; shutdown() clears it + exits explicitly.
  // Exponential backoff when the backend is unreachable (consecutive ingest failures) so a down
  // backend isn't hammered every poll; snaps back to the base interval on the first success.
  const schedule = () => {
    if (state.stopped) return;
    const fails = state.ingestFails || 0;
    const delay = fails > 0 ? Math.min(CFG.maxBackoffMs, CFG.pollMs * Math.min(2 ** fails, 8)) : CFG.pollMs;
    if (delay !== CFG.pollMs && delay !== state.lastDelay) log('backoff', { next_ms: delay, ingest_fails: fails });
    state.lastDelay = delay;
    timer = setTimeout(loop, delay);
  };
  const loop = async () => {
    try { await pushIfChanged(state); } catch (e) { log('tick_error', { error: e && e.message }); }
    schedule();
  };

  const shutdown = () => { state.stopped = true; if (timer) clearTimeout(timer); log('stopping', {}); process.exit(0); };
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
