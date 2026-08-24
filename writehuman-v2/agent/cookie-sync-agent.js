'use strict';
/**
 * WriteHuman — Universal Cookie Sync Agent.
 *
 * ONE package, installed unchanged on every authorised machine: the local PC, RDP-01, any future
 * approved RDP. Each installation holds its own identity (device id, device key, name, sequence
 * number) in `agent-device.json`, obtained once by redeeming a pairing code from the admin panel.
 * Nothing about the machine is compiled in, so adding or moving a machine needs no code change on
 * either side — sign in normally on whichever machine you like and that one takes over.
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

const AGENT_VERSION = '3.2.0';

// Single-source config: an optional config.json (non-secret settings, shared with the watchdog) is
// read as a fallback; ENV always takes precedence, so a service manager / run-agent.cmd can override.
// The AGENT KEY is read from ENV or a locked-down key FILE (WHV2_AGENT_KEY_FILE) — never from the
// shared config.json — so the secret isn't sitting in a world-readable launcher/config.
function readJsonFile(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function readKeyFile(p) { if (!p) return ''; try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; } }

/**
 * Read a DPAPI-protected key file (Windows, CurrentUser scope).
 *
 * The installer encrypts the shared ingest key with the Windows user's own DPAPI master key, so the
 * file on disk is useless to any other account on the machine and useless if copied elsewhere -
 * strictly better than a plaintext file whose only protection is an ACL. Node cannot call DPAPI
 * without a native module, so this shells out to PowerShell exactly ONCE at startup and keeps the
 * key in memory. Never per request, and never logged.
 *
 * Returns '' if the file is absent or cannot be decrypted (wrong user, corrupt, no PowerShell), and
 * the caller then falls back to the plaintext key file.
 */
function readDpapiKeyFile(p) {
  if (!p || process.platform !== 'win32') return '';
  try {
    if (!fs.existsSync(p)) return '';
    const { execFileSync } = require('child_process');
    const ps = 'try{$s=Get-Content -Raw -Path ' + JSON.stringify(p) +
      ';$ss=ConvertTo-SecureString $s.Trim();' +
      '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss);' +
      '[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)}catch{""}';
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return String(out || '').trim();
  } catch (_) { return ''; }
}
/**
 * Where config.json lives, in order: an explicit WHV2_CONFIG (what run-agent.cmd sets), then
 * BESIDE this file, then one directory up.
 *
 * The sibling lookup is not cosmetic. The installer copies the agent and its config into the SAME
 * directory, while the original repo layout kept config one level up - so without it, launching the
 * agent directly (no WHV2_CONFIG) silently loads NO config at all: default poll interval, default
 * paths, no key file, and the identity written to the wrong directory. It then dies with "no sync
 * key configured" while a perfectly good config.json sits next to the script. Found by running it.
 */
function resolveConfigPath() {
  if (process.env.WHV2_CONFIG) return process.env.WHV2_CONFIG;
  const sibling = path.join(__dirname, 'config.json');
  try { if (fs.existsSync(sibling)) return sibling; } catch (_) {}
  return path.join(__dirname, '..', 'config.json');
}
const CONFIG_PATH = resolveConfigPath();
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
  // Shared ingest key, in order of preference: env (service manager), DPAPI-protected file
  // (what the installer writes), then a plaintext key file (fallback for non-Windows or when
  // PowerShell is unavailable). Never read from config.json - that file is not a secret store.
  agentKey: process.env.WHV2_AGENT_KEY
    || readDpapiKeyFile(process.env.WHV2_AGENT_KEY_DPAPI || FILE_CFG.agentKeyDpapiFile)
    || readKeyFile(process.env.WHV2_AGENT_KEY_FILE) || readKeyFile(FILE_CFG.agentKeyFile) || '',
  cdpUrl: pick('WHV2_CDP_URL', 'cdpUrl', 'http://127.0.0.1:9222').replace(/\/$/, ''),
  domain: pick('WHV2_TARGET_DOMAIN', 'domain', 'writehuman.ai'),
  ref: pick('WHV2_SUPABASE_REF', 'ref', 'hicfsbrfkzsxbwayibfm'),
  // How often we ASK CHROME (local, cheap - no server traffic unless something changed).
  pollMs: Math.max(15000, parseInt(pick('WHV2_POLL_MS', 'pollMs', ''), 10) || 45000),
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
  // Which Chrome profile this device is authorised to read. Matched against the browser's own
  // reported user-data-dir; empty means 'whatever this debug port is attached to'.
  chromeProfile: pick('WHV2_CHROME_PROFILE', 'chromeProfile', ''),
  deviceName: pick('WHV2_DEVICE_NAME', 'deviceName', os.hostname()),
  // After a cookie CHANGE, poll faster for a short window: a Supabase rotation is usually followed
  // by more activity, and this catches the follow-up promptly without ever becoming busy-polling.
  quickPollMs: Math.max(5000, parseInt(pick('WHV2_QUICK_POLL_MS', 'quickPollMs', ''), 10) || 8000),
  quickPollFor: Math.max(0, parseInt(pick('WHV2_QUICK_POLL_COUNT', 'quickPollFor', ''), 10) || 4),
  // How often we TALK TO THE SERVER when nothing has changed. Decoupled from the Chrome poll on
  // purpose: checking cookies is a loopback call costing nothing, whereas a heartbeat is a request
  // to a shared, process-limited host. Polling Chrome every 45s while heartbeating every 3 minutes
  // gives fast detection at a quarter of the server traffic a 45s heartbeat would cause.
  heartbeatMs: Math.max(60000, parseInt(pick('WHV2_HEARTBEAT_MS', 'heartbeatMs', ''), 10) || 180000),
  // Never launch Chrome by default. On a personal machine an agent that opens browser windows is
  // obnoxious; on any machine it risks a second instance fighting over the profile lock.
  autoLaunchChrome: String(pick('WHV2_AUTO_LAUNCH_CHROME', 'autoLaunchChrome', '0')) === '1',
};

// ── device state (deviceId + deviceKey + monotonic seq) ──────────────────────
// Kept OUT of the shared config.json: it holds this machine's secret. Written with an owner-only
// mode; on Windows the ACL is applied by the provisioning script.
function loadDeviceState() {
  try {
    const s = JSON.parse(fs.readFileSync(CFG.deviceStateFile, 'utf8'));
    // A PAIRED device (has its own key) or a SELF-REGISTERED agent (id only, shared key).
    if (s && s.deviceId && s.deviceKey) return { deviceId: s.deviceId, deviceKey: s.deviceKey, seq: Number(s.seq) || 0, name: s.name || null };
    if (s && s.agentId) return { agentId: s.agentId, seq: Number(s.seq) || 0, name: s.name || null };
  } catch (_) { /* first run */ }
  return null;
}

/**
 * This machine's own identity, created on first run and kept forever after.
 *
 * There is no enrolment step: the agent invents a random id, and the server records it the first
 * time it sees it. That id is what per-device state hangs off server-side - the one-time activation
 * claim, the sequence number for replay rejection, revocation - so it has to be STABLE across
 * restarts and reinstalls of the same machine, and it must not be guessable by another machine.
 * 128 bits of randomness, written once.
 */
function ensureAgentIdentity() {
  const existing = loadDeviceState();
  if (existing) return existing;
  const st = { agentId: 'agent_' + crypto.randomBytes(16).toString('hex'), name: CFG.deviceName, seq: 0, createdAt: new Date().toISOString() };
  saveDeviceState(st);
  log('agent_identity_created', { agent_id: st.agentId, name: st.name });
  return st;
}
function saveDeviceState(st) {
  try {
    fs.writeFileSync(CFG.deviceStateFile, JSON.stringify(st, null, 2), { mode: 0o600 });
    return true;
  } catch (e) { log('device_state_write_failed', { error: e.message }); return false; }
}
/**
 * Browser-authorized enrolment (PKCE device flow).
 *
 * No key to copy. The agent proves it started the flow by holding a verifier whose hash it sent up
 * front, an admin approves the request in a browser they are already signed into, and the agent
 * then collects a credential that belongs to this machine alone.
 *
 * Polling rather than a localhost callback, deliberately: a callback means binding a port, parsing
 * a request from the browser, and accepting a redirect target - three attack surfaces (callback
 * injection, open redirect, code interception via the URL) that polling simply does not have. The
 * credential never touches a URL.
 */
function enrollUrl(kind) { return CFG.ingestUrl.replace(/\/cookies\/?$/, '/enroll/' + kind); }

function openInBrowser(url) {
  try {
    // `start` needs an empty title argument first, or a quoted URL is treated as the window title.
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (_) { return false; }
}

async function enrollViaBrowser(agentId) {
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  const startRes = await fetch(enrollUrl('start'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, codeChallenge: challenge, name: CFG.deviceName, hostname: os.hostname(), agentVersion: AGENT_VERSION }),
    signal: AbortSignal.timeout(20000),
  });
  const start = await startRes.json().catch(() => null);
  if (!startRes.ok || !start || !start.enrollId) {
    log('enroll_start_failed', { status: startRes.status, code: (start && start.code) || null });
    return null;
  }

  // Printed as well as opened: on a headless RDP session there may be no browser to open, and the
  // operator can paste this into a browser anywhere they can sign in as admin.
  log('enroll_waiting', { authorize_url: start.authorizeUrl, expires_at: start.expiresAt });
    console.log('');
    console.log('  Authorize this device by opening:');
    console.log('    ' + start.authorizeUrl);
    console.log('');
  openInBrowser(start.authorizeUrl);

  const interval = Math.max(2000, Number(start.pollIntervalMs) || 3000);
  let pollFails = 0;
  const deadline = Date.parse(start.expiresAt) || (Date.now() + 10 * 60 * 1000);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    let res, body;
    try {
      // Belt AND braces on the timeout. AbortSignal alone has not been enough in this codebase
      // before - a fetch stalled in DNS resolution can outlive its abort, and this loop then wedges
      // forever with nothing in the log to say so (observed: the agent sat on a dead enrolment past
      // its deadline through a local DNS outage, never timing out, never retrying, silent).
      res = await Promise.race([
        fetch(enrollUrl('poll'), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enrollId: start.enrollId, agentId, codeVerifier: verifier }),
          signal: AbortSignal.timeout(15000),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('poll_hard_timeout')), 20000)),
      ]);
      body = await res.json().catch(() => null);
    } catch (e) {
      // Never fail silently: a poll that cannot reach the server is the single most likely reason
      // enrolment "just does nothing", and it must be visible in the log.
      pollFails += 1;
      if (pollFails === 1 || pollFails % 10 === 0) log('enroll_poll_failed', { attempts: pollFails, error: e.message });
      continue;
    }
    if (res.status === 202) continue;               // admin has not clicked yet
    if (res.ok && body && body.deviceKey) {
      const st = { deviceId: body.deviceId, deviceKey: body.deviceKey, name: body.name || CFG.deviceName, seq: 0 };
      if (!saveDeviceState(st)) return null;
      log('enrolled', { device_id: st.deviceId, name: st.name, via: 'browser' });
      return st;
    }
    log('enroll_failed', { status: res.status, code: (body && body.code) || null });
    return null;                                    // consumed / expired / PKCE mismatch: do not retry
  }
  log('enroll_timeout', { note: 'nobody authorized the request in time; it will retry on next start' });
  return null;
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
// PROFILE SAFETY. The debug port identifies a running Chrome, not WHICH profile it opened, and
// reading the wrong profile is a silent failure: the agent syncs somebody else's (or an empty)
// session and everything downstream looks healthy. When `chromeProfile` is configured, the
// browser's own reported user-data-dir must contain it, or we refuse to read rather than sync
// from the wrong place. The value is recorded in telemetry so the dashboard can show which
// profile is actually feeding the account.
/**
 * Canonical filesystem-path comparison. A substring test is not good enough for deciding which
 * profile we are allowed to read: `C:\wh-profile` would match `C:\wh-profile-old`, and a
 * case/slash/trailing-separator difference would spuriously refuse the right one. Both failures are
 * silent in opposite directions — one syncs the wrong session, the other stops syncing entirely.
 * Windows paths are case-insensitive, so compare case-folded, separator-normalised, de-trailed.
 */
function canonicalPath(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}
function samePath(a, b) {
  const x = canonicalPath(a), y = canonicalPath(b);
  return !!x && !!y && x === y;
}

async function getAllCookiesViaCDP(cdpUrl, state) {
  // CDP must never be reached over anything but loopback. The debug port is unauthenticated: every
  // cookie in the profile is readable by whoever can connect, so a non-loopback endpoint would mean
  // the session is exposed to the network. Refuse rather than warn.
  const host = (() => { try { return new URL(cdpUrl).hostname; } catch (_) { return ''; } })();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('cdp_not_loopback');
  }

  const verRes = await fetch(cdpUrl + '/json/version', { signal: AbortSignal.timeout(8000) });
  if (!verRes.ok) throw new Error('cdp_version_http_' + verRes.status);
  const ver = await verRes.json();

  // Protocol compatibility: Storage.getCookies on the BROWSER target needs a modern Chrome. An old
  // build fails deep inside the websocket with an opaque error; naming it here saves the diagnosis.
  const proto = String(ver['Protocol-Version'] || '');
  const major = Number(String(ver.Browser || '').match(/\/(\d+)\./)?.[1] || 0);
  if (state) { state.cdpProtocol = proto || null; state.chromeMajor = major || null; }
  if (major && major < 90) throw new Error('cdp_chrome_too_old_' + major);

  // Chrome reports the profile path in the browser target's `userDataDir` (newer builds).
  const dir = ver.userDataDir || ver['user-data-dir'] || '';
  // Only the last two segments are kept for telemetry — a full filesystem path is never logged,
  // reported, or sent to the server.
  if (state) state.profile = dir ? String(dir).split(/[\\/]/).filter(Boolean).slice(-2).join('/') : null;
  if (CFG.chromeProfile) {
    if (!dir) throw new Error('cdp_profile_unknown');       // cannot prove it is the right one
    if (!samePath(dir, CFG.chromeProfile)) throw new Error('wrong_chrome_profile');
  }

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
    profile: state.profile || null,
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
  // A paired device sends its OWN key; a self-registered agent sends the shared ingest key plus the
  // id it generated. The server tells them apart by which header is present.
  const headers = { 'content-type': 'application/json', 'x-agent-key': (dev && dev.deviceKey) || CFG.agentKey };
  if (dev && dev.deviceId) headers['x-device-id'] = dev.deviceId;
  else if (dev && dev.agentId) headers['x-agent-id'] = dev.agentId;
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
    // Enrolment reply: the server issued this agent its own key. Persist it and use it from now
    // on, so the shared bootstrap key is never sent again and this machine can be revoked alone.
    if (body && body.issuedDeviceKey && body.deviceId && state.device) {
      state.device.deviceId = body.deviceId;
      state.device.deviceKey = body.issuedDeviceKey;
      delete state.device.agentId;
      if (saveDeviceState(state.device)) log('device_key_issued', { device_id: body.deviceId });
    }
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
    cookies = await getAllCookiesViaCDP(CFG.cdpUrl, state);
    state.cdp = '200'; state.chrome = true; state.lastError = null; state.cdpFails = 0;
  } catch (e) {
    state.cdp = 'DOWN'; state.chrome = false; state.lastError = e.message;
    state.cdpFails = (state.cdpFails || 0) + 1;
    recordError(state, 'cdp: ' + e.message);
    log('cdp_read_failed', { error: e.message, consecutive: state.cdpFails });
    // AUTO-RECOVERY: after N consecutive CDP failures the debug Chrome is likely dead/closed —
    // relaunch it via its task (faster than the 5-min watchdog). Cooldown-gated so it can't
    // relaunch-spam while Chrome is still coming back up.
    if (CFG.autoLaunchChrome && state.cdpFails >= CFG.cdpRelaunchAfter && (Date.now() - (state.lastRelaunchAt || 0)) > CFG.relaunchCooldownMs) {
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
      } else if (!state.lastHeartbeatAt || (Date.now() - state.lastHeartbeatAt) >= CFG.heartbeatMs) {
        state.lastHeartbeatAt = Date.now();
        await postToServer(state, { heartbeat: true, hash: null });
        log('browser_not_authenticated', { auth_cookies: 0, empty_polls: state.emptyPolls });
      }
    } else if (!state.lastHeartbeatAt || (Date.now() - state.lastHeartbeatAt) >= CFG.heartbeatMs) {
      state.lastHeartbeatAt = Date.now();
      await postToServer(state, { heartbeat: true, hash: null });
      log('browser_not_authenticated', { auth_cookies: 0 });
    }
    return;
  }
  state.emptyPolls = 0; state.loggedOutSent = false;
  const forced = !!state.forceNext;
  if (!forced && hash === state.lastHash) {
    // Nothing changed. Asking Chrome was free (loopback); telling the SERVER so is not, and this
    // runs on a host that has hit its process ceiling. So a no-change poll only reaches the network
    // when a heartbeat is actually due - at a 45s poll and a 3-minute heartbeat that is one request
    // in four. Liveness is unaffected: the dashboard's staleness window is far wider than 3 minutes.
    const due = !state.lastHeartbeatAt || (Date.now() - state.lastHeartbeatAt) >= CFG.heartbeatMs;
    if (!due) return;
    state.lastHeartbeatAt = Date.now();
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
  state.lastHeartbeatAt = Date.now();   // a push IS contact; no extra beat needed right after
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
  // Optional legacy path: an explicit pairing code still works and yields a per-device key.
  let device = loadDeviceState();
  if (!device && CFG.pairCode) {
    try { device = await pairDevice(CFG.pairCode); } catch (e) { log('pairing_error', { error: e.message }); }
  }
  // NORMAL path: no code, no approval. The agent invents its own id on first run and the server
  // records it the first time it authenticates with the shared ingest key.
  if (!device) device = ensureAgentIdentity();

  // No credential yet: enrol through the browser. Preferred over the shared bootstrap key, which is
  // now only used if one was explicitly configured (rollback / already-deployed agents).
  if (!device.deviceKey && !CFG.agentKey) {
    try {
      const enrolled = await enrollViaBrowser(device.agentId || device.deviceId);
      if (enrolled) device = enrolled;
    } catch (e) { log('enroll_error', { error: e.message }); }
  }

  if (!device.deviceKey && !CFG.agentKey) {
    log('fatal', {
      reason: 'not enrolled and no sync key configured',
      remedy: 'Start the agent again and click Authorize in the browser page it opens. (Legacy: -SyncKey <PROXY_AGENT_SYNC_KEY>.)',
      dpapi_file: process.env.WHV2_AGENT_KEY_DPAPI || FILE_CFG.agentKeyDpapiFile || null,
      key_file: process.env.WHV2_AGENT_KEY_FILE || FILE_CFG.agentKeyFile || null,
      device_state: CFG.deviceStateFile,
    });
    process.exit(1);
  }
  if (!/^https:/i.test(CFG.ingestUrl) && !/(127\.0\.0\.1|localhost)/i.test(CFG.ingestUrl)) {
    log('warn_insecure_ingest', { note: 'ingest URL is not https — the device key would travel in cleartext' });
  }
  const keySource = device && device.deviceKey ? 'paired-device-key'
    : (process.env.WHV2_AGENT_KEY ? 'env'
      : (readDpapiKeyFile(process.env.WHV2_AGENT_KEY_DPAPI || FILE_CFG.agentKeyDpapiFile) ? 'dpapi' : 'file'));
  log('starting', { version: AGENT_VERSION, ingest: CFG.ingestUrl, cdp: CFG.cdpUrl, domain: CFG.domain, poll_ms: CFG.pollMs, chrome_task: CFG.chromeTask, config: CONFIG_SOURCE, key_source: keySource, lock_file: CFG.lockFile, device_id: (device && (device.deviceId || device.agentId)) || null, device_name: device ? device.name : null, self_registered: !!(device && device.agentId) });

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
    // +/-10% jitter on the steady-state interval. Several devices installed from the same script
    // would otherwise drift into lockstep and hit the backend in a burst every cycle - harmless at
    // two machines, not harmless on an account that has run into its process ceiling before.
    // Backoff is left un-jittered: it is already spreading load by growing.
    if (fails === 0) delay = Math.round(delay * (0.9 + Math.random() * 0.2));
    // Only a real backoff is worth logging. Jitter means `delay` almost never equals pollMs, so
    // the old condition printed "backoff" on every healthy poll with ingest_fails 0 - noise that
    // makes a genuine backoff impossible to spot.
    if (fails > 0 && delay !== state.lastDelay) log('backoff', { next_ms: delay, ingest_fails: fails });
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

module.exports = { isAuthName, domainMatches, filterAuthCookies, hashAuthCookies, getAllCookiesViaCDP, buildReport, canonicalPath, samePath, AGENT_VERSION, CFG };

if (require.main === module) start();
