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

// 3.5.0 — `capture-and-activate` (this agent captures its OWN session on demand, so Mark Active
// stops depending on the machine happening to push), stage reporting so the dashboard shows a real
// progress step instead of an endless "syncing", and a stand-down that SURVIVES A RESTART.
//
// That last one matters more than it sounds. 3.4.0 stood down in memory only: a revoked agent went
// quiet, and then the next logon (or any restart) brought it straight back, polling with the same
// dead credential until the server refused it again. The marker file makes "this installation is
// finished" a fact on disk, so a retired agent stays retired until an installer clears it.
//
// 3.4.0 — ADDRESSED commands (this agent refuses anything not addressed to its own device id),
// stand-down on revoke (a revoked agent no longer keeps relaunching Chrome forever), and the
// token-rotation nudge that stops the dedicated Chrome rotating late.
// 3.5.1 — honours server directives on an answered refusal (409): the token-rotation nudge and the
//         addressed command used to be discarded exactly when the stored token had expired; and
//         every LOCAL interval uses a monotonic clock, so a backwards wall-clock correction can no
//         longer silence heartbeats (the source reported uptimeSec -6877 on 2026-10-05).
// 3.5.3 — SOURCE-SIDE AUTOMATIC RE-LOGIN (opt-in, WHV2_RELOGIN=1). On a CONFIRMED logout of
//         this machine's own source account, sign back in through WriteHuman's normal login page
//         in the tab that is already open, once, using a DPAPI CurrentUser credential readable
//         only by this Windows user; then let the existing sync pipeline verify and promote it.
//         Never touches the refresh token, never adds a visible tab, and halts for MFA / CAPTCHA /
//         wrong password / rate limit / restriction / wrong account.
// 3.5.2 — the success log no longer throws (`forced is not defined` hid every successful sync as a
//         tick_error), and each push / refusal logs the candidate token's EXPIRY TIME (never the
//         token), so a run of refusals shows whether Chrome had actually rotated.
const AGENT_VERSION = '3.5.3';

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
  // The dedicated-Chrome launcher exe (the installed WriteHumanAgent.exe run with --launch-chrome).
  // When set (the one-click install path), relaunch goes through it instead of a scheduled task -
  // it manages ONLY our dedicated profile and never the user's everyday Chrome.
  chromeLauncher: pick('WHV2_CHROME_LAUNCHER', 'chromeLauncher', ''),
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
  // The terminal stand-down marker. Written when the server says this installation is finished
  // (revoked / uninstalled / superseded), and checked at STARTUP — which is the whole point. A
  // stand-down held only in memory is undone by the next logon, and that is exactly how a revoked
  // machine went on relaunching its own dedicated WriteHuman Chrome for hours.
  standDownFile: process.env.WHV2_STAND_DOWN || FILE_CFG.standDownFile
    || path.join(path.dirname(process.env.WHV2_DEVICE_STATE || FILE_CFG.deviceStateFile || path.join(__dirname, '..', 'agent-device.json')), 'stood-down.json'),
  pairCode: process.env.WHV2_PAIR_CODE || '',
  // How long a `capture-and-activate` may spend bringing Chrome up and waiting for somebody to be
  // signed in before it gives up and reports a stated failure. Bounded so an activation can never
  // hold a machine in a capture loop; the server-side transaction expires independently anyway.
  activationWaitMs: Math.max(30000, parseInt(pick('WHV2_ACTIVATION_WAIT_MS', 'activationWaitMs', ''), 10) || 8 * 60000),
  // Which Chrome profile this device is authorised to read. Matched against the browser's own
  // reported user-data-dir; empty means 'whatever this debug port is attached to'.
  chromeProfile: pick('WHV2_CHROME_PROFILE', 'chromeProfile', ''),
  deviceName: pick('WHV2_DEVICE_NAME', 'deviceName', os.hostname()),
  // After a cookie CHANGE, poll faster for a short window: a Supabase rotation is usually followed
  // by more activity, and this catches the follow-up promptly without ever becoming busy-polling.
  quickPollMs: Math.max(5000, parseInt(pick('WHV2_QUICK_POLL_MS', 'quickPollMs', ''), 10) || 8000),
  quickPollFor: Math.max(0, parseInt(pick('WHV2_QUICK_POLL_COUNT', 'quickPollFor', ''), 10) || 4),
  // ── source-side automatic re-login (3.5.3) ─────────────────────────────────
  // OFF unless explicitly switched on, so recovering this source file onto an
  // existing install changes NOTHING until an operator opts in. Enabling it does
  // not touch the Observe/Enforce policy, which is a server-side setting.
  reloginEnabled: String(pick('WHV2_RELOGIN', 'reloginEnabled', '')).trim() === '1',
  // WriteHuman's own login surface. Matches the SIGNIN_PATH the backend registry
  // already uses for this tool, and is overridable if the app ever moves it.
  loginPath: pick('WHV2_LOGIN_PATH', 'loginPath', '/signup?mode=login'),
  // How often we TALK TO THE SERVER when nothing has changed. Decoupled from the Chrome poll on
  // purpose: checking cookies is a loopback call costing nothing, whereas a heartbeat is a request
  // to a shared, process-limited host. Polling Chrome every 45s while heartbeating every 3 minutes
  // gives fast detection at a quarter of the server traffic a 45s heartbeat would cause.
  heartbeatMs: Math.max(60000, parseInt(pick('WHV2_HEARTBEAT_MS', 'heartbeatMs', ''), 10) || 180000),
  // Never launch Chrome by default. On a personal machine an agent that opens browser windows is
  // obnoxious; on any machine it risks a second instance fighting over the profile lock.
  autoLaunchChrome: /^(1|true|yes)$/i.test(String(pick('WHV2_AUTO_LAUNCH_CHROME', 'autoLaunchChrome', '0'))),
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
// ── terminal stand-down (survives a restart) ─────────────────────────────────
/**
 * "This installation is finished." Written when the server refuses us as REVOKED, UNINSTALLED or
 * SUPERSEDED, and read at startup before anything else happens.
 *
 * 3.4.0 stood down in memory, which quietly did not solve the problem it was written for: the
 * agent went quiet until the next logon, and then started again, polled with the same dead
 * credential, and — because `isActiveSource` is undefined until a reply arrives and CDP failures
 * accumulate faster than refusals — could still take a run at relaunching its own Chrome. The
 * observed shape of this on a live machine was `heartbeat_rejected {status:403}` followed by
 * `relaunch_chrome {reason:"cdp_auto"}` every few minutes, for hours.
 *
 * The marker is deliberately a FILE next to the credential, not a flag inside it: the credential
 * may be archived or wiped by an uninstall, and the fact that this machine has been retired must
 * outlive that. Only an installer clears it.
 */
function readStandDown() {
  try { return JSON.parse(fs.readFileSync(CFG.standDownFile, 'utf8')); } catch (_) { return null; }
}
function writeStandDown(code, reason, deviceId) {
  try {
    fs.writeFileSync(CFG.standDownFile, JSON.stringify({
      code: code || 'DEVICE_REVOKED', reason: reason || null, deviceId: deviceId || null,
      at: new Date().toISOString(), agentVersion: AGENT_VERSION,
    }, null, 2), { mode: 0o600 });
    return true;
  } catch (e) { log('stand_down_write_failed', { error: e.message }); return false; }
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
// Monotonic milliseconds for LOCAL intervals (heartbeat due, cooldowns, activation deadline,
// uptime). Date.now() is wall-clock: a Windows time correction can move it backwards by hours,
// and `Date.now() - lastX` then stays below every threshold for that long. Wall-clock is still
// right for server-issued expiry times, for timestamps we report, and for the cross-process lock.
function monoNow() { return Number(process.hrtime.bigint() / 1000000n); }
function heartbeatDue(state) { return !state.lastHeartbeatAt || (monoNow() - state.lastHeartbeatAt) >= CFG.heartbeatMs; }
function log(event, fields) { try { console.log(`[${new Date().toISOString()}] [wh-v2-agent] ${event} ${JSON.stringify(fields || {})}`); } catch (_) {} }

/**
 * The three server refusals that mean this installation is over. All of them are terminal, and all
 * of them are cleared the same way: run the installer again, which archives the dead identity and
 * starts a fresh browser authorization for a NEW one.
 *
 * 3.4.0 only recognised DEVICE_REVOKED here, so a SUPERSEDED duplicate (a machine that had already
 * reinstalled and re-enrolled) and an UNINSTALLED row carried on polling indefinitely.
 */
const TERMINAL_CODES = ['DEVICE_REVOKED', 'DEVICE_UNINSTALLED', 'DEVICE_SUPERSEDED'];

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
// The candidate token's expiry, as an ISO TIME — read from the Supabase auth cookie (whole, or its
// .0/.1 chunks joined in order). Only `expires_at` (or the JWT `exp`) is extracted; the token itself
// never leaves this function. Null when it cannot be read.
function authTokenExpiry(authList, ref) {
  try {
    const base = authTokenBase(ref);
    const list = Array.isArray(authList) ? authList : [];
    const whole = list.find(c => c && c.name === base);
    const chunks = list.filter(c => c && typeof c.name === 'string' && c.name.startsWith(base + '.'))
      .map(c => [parseInt(c.name.slice(base.length + 1), 10), c.value])
      .filter(([n]) => Number.isFinite(n)).sort((x, y) => x[0] - y[0]);
    let raw = chunks.length ? chunks.map(([, v]) => v).join('') : (whole && whole.value);
    if (!raw) return null;
    raw = String(raw);
    if (/%[0-9A-Fa-f]{2}/.test(raw)) { try { raw = decodeURIComponent(raw); } catch (_) {} }
    const json = raw.startsWith('base64-') ? Buffer.from(raw.slice(7).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : raw;
    let exp = null;
    const ea = json.match(/"expires_at":(\d+)/);
    if (ea) exp = Number(ea[1]);
    if (!exp) {
      const at = json.match(/"access_token":"([^"]+)"/);
      const part = at && at[1].split('.')[1];
      if (part) exp = Number(JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).exp);
    }
    return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString() : null;
  } catch (_) { return null; }
}
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

  // Chrome USED to report the profile path in /json/version `userDataDir`, but Chrome 151 dropped
  // it (confirmed live: the field is simply absent). The dedicated-profile model does not depend on
  // it: WE launch our own Chrome on a DEDICATED debug port that only our --user-data-dir listens on,
  // so the port itself is the pin. So an ABSENT userDataDir is fine — proceed. Only a userDataDir
  // that is PRESENT and points somewhere else is a real wrong-profile signal (older Chrome, or an
  // operator attaching to a shared port), and that still refuses.
  const dir = ver.userDataDir || ver['user-data-dir'] || '';
  if (state) state.profile = dir ? String(dir).split(/[\\/]/).filter(Boolean).slice(-2).join('/') : 'dedicated-port';
  if (CFG.chromeProfile && dir && !samePath(dir, CFG.chromeProfile)) {
    throw new Error('wrong_chrome_profile');
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

/**
 * Ask the dedicated Chrome to rotate the Supabase access token NOW, by reloading its WriteHuman
 * tab. The app's own client does the refresh on load, so the BROWSER stays the sole rotator and
 * nothing here ever touches the refresh token — which is what keeps Supabase reuse-detection out
 * of the picture entirely.
 *
 * WHY THIS EXISTS. WriteHuman's access token lives ~1 hour, and Chrome heavily throttles timers in
 * a backgrounded window, so the SDK's auto-refresh fires late: measured on the real source machine,
 * rotations landed 63, 67, 68 and 86 minutes apart on a 60-minute token. For those extra minutes
 * the stored token was expired, the dashboard called the session stale, and the only cure anyone
 * had was to go and refresh the RDP browser by hand — every hour, forever. Reloading the tab a few
 * minutes BEFORE expiry removes the chore without changing who rotates.
 *
 * Never launches Chrome. If Chrome is not running, or there is no WriteHuman tab and one cannot be
 * opened, this does nothing and says so.
 */
async function nudgeTokenRotation(state, reason) {
  const cdpUrl = CFG.cdpUrl;
  const host = (() => { try { return new URL(cdpUrl).hostname; } catch (_) { return ''; } })();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return false;
  try {
    const listRes = await fetch(cdpUrl + '/json/list', { signal: AbortSignal.timeout(6000) });
    if (!listRes.ok) return false;
    const targets = await listRes.json();
    const page = (Array.isArray(targets) ? targets : []).find(t =>
      t && t.type === 'page' && typeof t.url === 'string' && t.url.includes(CFG.domain));

    if (!page) {
      // No WriteHuman tab open. Opening one is a tab, not a browser — and without it an idle
      // dedicated Chrome would never rotate at all. Chrome 111+ requires PUT on /json/new.
      const newRes = await fetch(cdpUrl + '/json/new?url=' + encodeURIComponent('https://' + CFG.domain + '/'),
        { method: 'PUT', signal: AbortSignal.timeout(6000) }).catch(() => null);
      log('token_nudge', { reason, action: newRes && newRes.ok ? 'opened_tab' : 'no_tab' });
      return !!(newRes && newRes.ok);
    }
    if (!page.webSocketDebuggerUrl || typeof WebSocket === 'undefined') return false;

    const ok = await new Promise((resolve) => {
      let settled = false;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const done = (v) => { if (settled) return; settled = true; clearTimeout(t); try { ws.close(); } catch (_) {} resolve(v); };
      const t = setTimeout(() => done(false), 8000);
      ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: false } })); } catch (_) { done(false); } };
      ws.onmessage = (ev) => {
        try { const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); if (m.id === 1) done(!m.error); }
        catch (_) { /* ignore */ }
      };
      ws.onerror = () => done(false);
      ws.onclose = () => done(false);
    });
    state.lastNudgeAt = monoNow();
    log('token_nudge', { reason, action: ok ? 'reloaded' : 'reload_failed' });
    // A rotation lands a moment later; poll fast for a short burst so the new cookie reaches the
    // server in seconds rather than at the next 45-second tick.
    if (ok) state.quickPollsLeft = Math.max(state.quickPollsLeft || 0, CFG.quickPollFor || 4);
    return ok;
  } catch (e) {
    log('token_nudge_failed', { reason, error: e && e.message });
    return false;
  }
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
    uptimeSec: Math.round((monoNow() - state.startedAt) / 1000),
    lastCommand: state.lastCommand || null,
    lastCommandAt: state.lastCommandAt ? new Date(state.lastCommandAt).toISOString() : null,
    profile: state.profile || null,
    // Source-side recovery status. ADDITIVE and non-secret: whether recovery is even
    // switched on, and - the part that matters operationally - whether it has HALTED
    // and needs a human (MFA, CAPTCHA, wrong password, rate limit, restriction, wrong
    // account). Never the account, never the credential. An older server simply
    // ignores the extra keys, so this is safe to report before any backend change.
    relogin: reloginReport(),
  };
}

// Non-secret snapshot of the recovery budget / halt state for the dashboard.
function reloginReport() {
  try {
    if (!CFG.reloginEnabled) return { enabled: false };
    const st = readReloginState();
    const now = Date.now();
    const recent = (st.attempts || []).filter(t => now - t < RELOGIN.windowMs);
    return {
      enabled: true,
      hasCredential: !!readSourceCredentialPresence(),
      attemptsInWindow: recent.length,
      maxAttempts: RELOGIN.maxAttempts,
      haltedReason: st.haltedReason || null,
      haltedAt: st.haltedAt || null,
      lastOutcome: st.lastOutcome || null,
      lastAttemptAt: st.lastAttemptAt || null,
    };
  } catch (_) { return { enabled: !!CFG.reloginEnabled }; }
}

// Does a credential vault EXIST? Deliberately a file-existence check only - it never
// decrypts, so the heartbeat cannot be used to exercise DPAPI on every poll.
function readSourceCredentialPresence() {
  try {
    const p = process.env.WHV2_CREDENTIAL_VAULT || FILE_CFG.credentialVaultFile
      || path.join(path.dirname(CFG.deviceStateFile), 'source-credential.dpapi');
    return fs.existsSync(p);
  } catch (_) { return false; }
}

// The server's directives, from any reply that carries them (2xx, or an answered 409 refusal).
function applyDirectives(state, body) {
  // Am I the machine currently supplying the session? Everything that touches the BROWSER is
  // gated on this: a standby must never open Chrome or nudge a token.
  state.isActiveSource = body && body.isActiveSource === true;
  state.superseded = !!(body && body.superseded);
  // The server's canonical verdict on what this machine IS (READY / ACTIVE / STANDBY / …). Kept
  // in telemetry so a disagreement between "what the box thinks it is" and "what the server
  // thinks it is" becomes visible — that disagreement is the shape of every wrong-machine bug
  // this system has had.
  state.deviceState = (body && body.deviceState) || null;
  // A terminal verdict can arrive on any answered reply (a row retired between our authentication
  // and this reply). Treat it exactly like the 403: persist it and go dormant.
  if (body && body.standDown === true && !state.standDown) {
    state.standDown = true;
    state.standDownCode = body.deviceState || 'DEVICE_REVOKED';
    log('stand_down', { code: state.standDownCode, reason: body.standDownReason || null, persisted: true });
    writeStandDown(state.standDownCode, body.standDownReason || null, state.device && (state.device.deviceId || state.device.agentId));
  }
  // How long until the stored access token expires, as the SERVER sees it. Only the active
  // source is ever told. This is what lets rotation happen ON TIME instead of whenever a
  // throttled background timer in Chrome eventually gets round to it.
  state.rotateTokenIn = (body && typeof body.rotateTokenIn === 'number') ? body.rotateTokenIn : null;
  if (body && body.command) handleCommand(state, body.command);
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
  // Report what happened to the last command we were given, so the dashboard can say "RDP-01 ran
  // it" rather than only "we queued it". Purely observational — it grants nothing.
  if (state.pendingAck) { envelope.commandAck = state.pendingAck; state.pendingAck = null; }
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
    applyDirectives(state, body);
    return body || {};
  }
  // STAND DOWN. A revoked device used to log its 403 and carry right on — polling every 45 seconds
  // and auto-relaunching the dedicated Chrome on that machine indefinitely, which is exactly how
  // WriteHuman Chrome kept appearing on a computer that was no longer the source. When the server
  // says the credential is gone, stop touching the browser and go quiet.
  if (resp.status === 403 && body && (body.standDown === true || TERMINAL_CODES.includes(body.code))) {
    if (!state.standDown) {
      log('stand_down', { code: body.code, reason: body.hint || 'retired_by_server', persisted: true });
      // Persist it. Without this the stand-down lasts only until the next logon, which is how a
      // retired machine came back and started touching its browser again.
      writeStandDown(body.code, body.hint || null, state.device && (state.device.deviceId || state.device.agentId));
    }
    state.standDown = true;
    state.standDownCode = body.code || 'DEVICE_REVOKED';
    recordError(state, 'retired: ' + (body.code || 'DEVICE_REVOKED'));
    return { _status: resp.status, body, code: body.code, standDown: true };
  }
  // A 4xx is the server ANSWERING us — the candidate was judged and refused (stale, wrong account,
  // replayed). That is not unreachability, so it must not drive the backoff that exists to stop us
  // hammering a down backend; treating a healthy "your bundle is older than the active one" as an
  // outage would back the agent off to 5-minute polls for no reason.
  if (resp.status >= 500 || resp.status === 429) state.ingestFails = (state.ingestFails || 0) + 1;
  // An ANSWERED refusal still carries the server's directives (it always sends `deviceState` with
  // them). 3.5.0 threw them away, and the commonest refusal — VERIFICATION_INCONCLUSIVE, because the
  // stored token has expired — is exactly when the rotation nudge is needed. A 429/5xx carries none.
  else if (body && typeof body === 'object' && body.deviceState) applyDirectives(state, body);
  recordError(state, 'ingest_http_' + resp.status + ((body && body.code) ? ' ' + body.code : ''));
  return { _status: resp.status, body, code: body && body.code };
}

// Execute a whitelisted remote command from the dashboard. Best-effort; never throws.
// Relaunch the dedicated WriteHuman Chrome: prefer the exe launcher (dedicated-profile safe),
// fall back to the RDP scheduled task for the legacy provisioning.
function relaunchChrome(reason) {
  try {
    if (CFG.chromeLauncher) {
      log('relaunch_chrome', { via: 'launcher', reason });
      const p = spawn(CFG.chromeLauncher, ['--launch-chrome'], { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', (e) => log('relaunch_failed', { error: e.message })); p.unref();
    } else {
      log('relaunch_chrome', { via: 'task', task: CFG.chromeTask, reason });
      const p = spawn('schtasks', ['/run', '/tn', CFG.chromeTask], { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', (e) => log('relaunch_failed', { error: e.message })); p.unref();
    }
  } catch (e) { log('relaunch_failed', { error: e.message }); }
}

/**
 * Execute a command from the dashboard — but ONLY if it is addressed to THIS device.
 *
 * The server already refuses to address a revoked / superseded / non-active-source machine, and it
 * only ever hands a command to the device named in it. This check is the second, independent lock:
 * a server bug, a shared response, or a replayed body must not be able to move a browser on the
 * wrong computer. Two independent guards, because the failure mode is a Chrome window opening on
 * someone's desk.
 *
 * Accepts the 3.4.0 ADDRESSED object. The pre-3.4.0 bare string carried no target at all and is
 * deliberately refused rather than obeyed.
 */
function handleCommand(state, cmd) {
  const myId = state.device && (state.device.deviceId || state.device.agentId);
  try {
    if (typeof cmd === 'string') {
      // Unaddressed legacy command. This is the shape that landed on the wrong machine.
      log('command_rejected', { reason: 'unaddressed_legacy_command', command: cmd });
      return;
    }
    if (!cmd || typeof cmd !== 'object' || !cmd.id || !cmd.type) {
      log('command_rejected', { reason: 'malformed' }); return;
    }
    if (!cmd.targetDeviceId || cmd.targetDeviceId !== myId) {
      log('command_rejected', { reason: 'not_addressed_to_me', command_id: cmd.id, target: cmd.targetDeviceId, me: myId });
      return;
    }
    if (cmd.tool && cmd.tool !== 'writehuman') {
      log('command_rejected', { reason: 'wrong_tool_scope', command_id: cmd.id, tool: cmd.tool }); return;
    }
    if (cmd.expiresAt && new Date(cmd.expiresAt).getTime() <= Date.now()) {
      log('command_rejected', { reason: 'expired', command_id: cmd.id }); return;
    }
    if (state.standDown) { log('command_rejected', { reason: 'stood_down', command_id: cmd.id }); return; }

    state.lastCommand = cmd.type; state.lastCommandAt = Date.now();
    state.pendingAck = { commandId: cmd.id, nonce: cmd.nonce, ok: true, result: null };

    if (cmd.type === 'resync') {
      // Re-read the cookies and offer them again on the next poll. It clears `lastHash` only.
      //
      // It used to also set a `force` flag in the request body, which the server honoured by
      // bypassing the unchanged-hash check, the trusted-ordering check AND the standby rule. That
      // put "may this machine overwrite the live session" in the hands of the machine asking, so
      // the server no longer reads it and the agent no longer sends it. Re-syncing is a refresh,
      // not a promotion: if the intent is to move the session, that is Mark Active.
      state.lastHash = null;
      log('command_resync', { command_id: cmd.id });
      state.pendingAck.result = 'resync_queued';
      return;
    }
    if (cmd.type === 'rotate-token') {
      // Nudge the WriteHuman tab so Supabase rotates the access token now rather than late. No
      // browser is launched; if Chrome is not there this simply does nothing.
      nudgeTokenRotation(state, 'command').then((r) => { state.pendingAck = { commandId: cmd.id, nonce: cmd.nonce, ok: !!r, result: r ? 'rotated' : 'no_tab' }; }).catch(() => {});
      return;
    }
    if (cmd.type === 'capture-and-activate') {
      // MARK ACTIVE, on this machine. The server addressed this to us and handed us a one-time
      // capability; runActivation is what makes the operator's click actually do something here
      // rather than the server waiting and hoping we push of our own accord.
      if (!cmd.activationId || !cmd.activationNonce) {
        log('command_rejected', { reason: 'activation_capability_missing', command_id: cmd.id });
        state.pendingAck = { commandId: cmd.id, nonce: cmd.nonce, ok: false, result: 'no_capability' };
        return;
      }
      if (state.activation && state.activation.running) {
        log('command_ignored', { reason: 'activation_already_running', command_id: cmd.id });
        return;
      }
      state.activation = { id: cmd.activationId, nonce: cmd.activationNonce, running: true, startedAt: monoNow(), commandId: cmd.id };
      state.pendingAck.result = 'capture_started';
      runActivation(state).catch((e) => log('activation_error', { error: e && e.message }));
      return;
    }
    if (cmd.type === 'open-chrome') {
      // The ONE command that starts a browser process. It reached here only because the server
      // addressed it to this device AND this device confirmed the address above.
      relaunchChrome('command:' + cmd.id);
      state.pendingAck.result = 'chrome_launch_requested';
      return;
    }
    log('command_unknown', { command: cmd.type, command_id: cmd.id });
  } catch (e) { log('command_failed', { command: cmd && cmd.type, error: e.message }); }
}

/**
 * Run one activation to completion on THIS machine.
 *
 * The stages it reports are the operator's progress bar. Each one is a real thing happening here,
 * which is the difference between the dashboard saying "Opening WriteHuman Chrome on the selected
 * RDP" and the dashboard saying "syncing" for fifteen minutes and then nothing:
 *
 *   OPENING_CHROME            our dedicated Chrome is not up; bring it up (we were asked to)
 *   WAITING_FOR_AUTH_COOKIES  Chrome is up, but nobody is signed in to WriteHuman on it
 *   CAPTURING                 reading the allowlisted cookies over loopback CDP
 *   UPLOADING                 handing them to the server with the activation id + nonce
 *
 * Everything after that is the server's to decide and to report. This function never promotes
 * anything; it only produces a candidate and says what it is doing.
 *
 * Two deliberate properties:
 *   - it captures even when the cookie hash is unchanged, because "which machine supplies the
 *     session" is not a question about whether the bytes changed;
 *   - it gives up on its own deadline with a STATED failure, so a machine that is signed out does
 *     not leave the operator watching a spinner until the transaction silently expires.
 */
async function runActivation(state) {
  const act = state.activation;
  const deadline = act.startedAt + CFG.activationWaitMs;   // monotonic (startedAt = monoNow())
  const report = (stage, note) => postToServer(state, {
    heartbeat: true, hash: null, activationId: act.id, activationStage: stage, activationNote: note || null,
  });
  const giveUp = async (code, note) => {
    log('activation_failed', { activation_id: act.id, code, note: note || null });
    act.running = false;
    state.activation = null;
    await postToServer(state, {
      heartbeat: true, hash: null, activationId: act.id, activationNonce: act.nonce,
      activationFailed: code, activationNote: note || null,
    });
  };

  log('activation_started', { activation_id: act.id, wait_ms: CFG.activationWaitMs });
  let announcedWaiting = false;

  while (monoNow() < deadline) {
    if (state.standDown) return giveUp('DEVICE_RETIRED', 'This device was retired while the capture was running.');

    // 1. Our own dedicated Chrome must be up. This is the ONE case where a non-active-source
    //    machine may start a browser: an operator has just asked for this machine by name.
    let cookies = null;
    try {
      cookies = await getAllCookiesViaCDP(CFG.cdpUrl, state);
      state.cdp = '200'; state.chrome = true; state.cdpFails = 0;
    } catch (e) {
      state.cdp = 'DOWN'; state.chrome = false;
      await report('OPENING_CHROME', 'CDP is down; starting the dedicated WriteHuman Chrome');
      if ((monoNow() - (state.lastRelaunchAt || 0)) > CFG.relaunchCooldownMs) {
        state.lastRelaunchAt = monoNow();
        relaunchChrome('activation:' + act.id);
      }
      await sleep(5000);
      continue;
    }

    // 2. Chrome is up. Is anybody signed in to WriteHuman on it?
    const auth = filterAuthCookies(cookies, CFG.domain, CFG.ref);
    state.authCount = auth.length;
    if (!auth.length) {
      if (!announcedWaiting) { announcedWaiting = true; log('activation_waiting_for_login', { activation_id: act.id }); }
      await report('WAITING_FOR_AUTH_COOKIES', 'No signed-in WriteHuman session in this machine’s dedicated Chrome yet');
      await sleep(6000);
      continue;
    }

    // 3. Capture and upload. Note there is NO hash comparison: an identical bundle is exactly the
    //    normal case when the same account is signed in on the new machine, and it must still
    //    complete the handover.
    const hash = hashAuthCookies(auth);
    await report('CAPTURING', null);
    log('activation_capturing', { activation_id: act.id, auth_cookies: auth.length, hash: hash ? hash.slice(0, 8) : null });

    const r = await postToServer(state, {
      cookies: auth, activationId: act.id, activationNonce: act.nonce, activationStage: 'UPLOADING',
    });
    if (r && r._err) { await sleep(5000); continue; }        // transport failure: retry inside the window
    act.running = false;
    state.activation = null;
    if (r && r._status) {
      log('activation_rejected', { activation_id: act.id, status: r._status, code: (r.body && r.body.code) || r.code || null });
      return;                                                 // the server has already failed the transaction and said why
    }
    state.lastHash = hash;
    state.lastHeartbeatAt = monoNow();
    log('activation_uploaded', {
      activation_id: act.id, code: r.code || null, promoted: r.promoted === true,
      source_switched: r.sourceSwitched === true, stage: (r.activation && r.activation.stage) || null,
    });
    return;
  }
  return giveUp('AGENT_TIMEOUT', 'This machine could not produce a signed-in WriteHuman session in time.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─────────────────────────────────────────────────────────────────────────────
 * SOURCE-SIDE AUTOMATIC RE-LOGIN (3.5.3)
 *
 * WHAT THIS IS. When the MAIN WriteHuman account on THIS approved source machine
 * is genuinely signed out, sign it back in through WriteHuman's own normal login
 * page, in the dedicated Chrome tab that is already open, exactly once — then let
 * the EXISTING sync pipeline pick the new session up. Nothing else changes.
 *
 * WHAT IT IS NOT. It is not a client-side login: no customer browser, extension or
 * dashboard is involved and none of them ever receives the credential. It is not a
 * second rotator either — it never touches the refresh token. The browser remains
 * the sole rotator, so Supabase reuse-detection stays out of the picture, exactly
 * as nudgeTokenRotation() is careful to preserve.
 *
 * WHEN IT RUNS. Only from the `logout_signaled` path, which is already the
 * CONFIRMED-logout path: the Supabase auth cookie has been absent for
 * CFG.logoutDebounce consecutive polls AND the browser had previously been
 * authenticated (state.lastHash !== null). An inconclusive poll — CDP down, Chrome
 * closed, a network error, a transient read failure — never reaches it, which is
 * the "do not recover on inconclusive verification alone" requirement.
 *
 * WHO VERIFIES THE ACCOUNT. We do a local sanity check (the auth cookie came back
 * and we are off the login route), but the AUTHORITATIVE identity check stays
 * server-side: clearing state.lastHash makes the next poll offer the bundle, and
 * candidateSync performs its usual provider-authenticated verify plus the
 * expectedAccountId match. If the server answers ACCOUNT_MISMATCH we halt
 * permanently — a recovered-but-wrong account must never be promoted.
 *
 * CREDENTIAL SOURCE. A DPAPI CurrentUser blob written by Enroll-SourceCredential.ps1,
 * readable only by this Windows user on this machine. It is read at the moment of
 * recovery, used, and dropped; it is never logged, never put in a URL, never sent to
 * the server, and never written into config.json. The password reaches the page via
 * Input.insertText (loopback CDP to our own browser), so it is never interpolated
 * into evaluated JavaScript.
 *
 * SAFETY RAILS. Opt-in (off unless WHV2_RELOGIN=1); active source only; single
 * flight; bounded attempts inside a rolling window; cooldown between attempts;
 * state persisted so a restart cannot reset the budget; and a PERSISTENT HALT on
 * anything a machine must not retry — wrong password, MFA, CAPTCHA, rate limit,
 * account restriction, wrong account. A halt requires an operator to clear it.
 * ───────────────────────────────────────────────────────────────────────────── */

const RELOGIN = {
  // Hard ceilings. Deliberately small: recovery is a once-in-a-while repair, and a
  // login form is the last place a machine should be allowed to retry freely.
  maxAttempts: Math.max(1, parseInt(pick('WHV2_RELOGIN_MAX', 'reloginMax', ''), 10) || 3),
  windowMs: Math.max(30 * 60000, parseInt(pick('WHV2_RELOGIN_WINDOW_MS', 'reloginWindowMs', ''), 10) || 6 * 60 * 60000),
  cooldownMs: Math.max(5 * 60000, parseInt(pick('WHV2_RELOGIN_COOLDOWN_MS', 'reloginCooldownMs', ''), 10) || 30 * 60000),
  // How long to wait for the app to finish signing in before calling it a failure.
  authWaitMs: Math.max(15000, parseInt(pick('WHV2_RELOGIN_WAIT_MS', 'reloginWaitMs', ''), 10) || 60000),
};
// Reasons that must NEVER be retried automatically. Each one needs a human: a
// wrong password will lock the account, and MFA/CAPTCHA exist precisely to stop
// automation. Persisted, so a restart does not quietly resume hammering.
const RELOGIN_TERMINAL = ['wrong_credentials', 'mfa_required', 'captcha_required', 'rate_limited', 'account_restricted', 'wrong_account'];

function reloginStatePath() {
  return process.env.WHV2_RELOGIN_STATE || FILE_CFG.reloginStateFile
    || path.join(path.dirname(CFG.deviceStateFile), 'agent-relogin.json');
}
function readReloginState() {
  const s = readJsonFile(reloginStatePath());
  if (!s || typeof s !== 'object') return { attempts: [], haltedReason: null, haltedAt: null };
  return {
    attempts: Array.isArray(s.attempts) ? s.attempts.filter(n => Number.isFinite(n)) : [],
    haltedReason: typeof s.haltedReason === 'string' ? s.haltedReason : null,
    haltedAt: s.haltedAt || null,
    lastOutcome: typeof s.lastOutcome === 'string' ? s.lastOutcome : null,
    lastAttemptAt: s.lastAttemptAt || null,
  };
}
function writeReloginState(st) {
  try {
    fs.mkdirSync(path.dirname(reloginStatePath()), { recursive: true });
    fs.writeFileSync(reloginStatePath(), JSON.stringify(st, null, 2));
  } catch (e) { log('relogin_state_write_failed', { error: e && e.message }); }
}

/**
 * The credential for THIS machine's source account. DPAPI CurrentUser, same
 * mechanism (and same PowerShell round-trip) as the shared ingest key — see
 * readDpapiKeyFile. Returns null when absent or undecryptable; the caller then
 * reports that recovery is unavailable rather than guessing.
 *
 * NEVER log the return value or any part of it.
 */
function readSourceCredential() {
  const p = process.env.WHV2_CREDENTIAL_VAULT || FILE_CFG.credentialVaultFile
    || path.join(path.dirname(CFG.deviceStateFile), 'source-credential.dpapi');
  const raw = readDpapiKeyFile(p);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o.email !== 'string' || typeof o.password !== 'string') return null;
    if (!o.email || !o.password) return null;
    return { email: o.email, password: o.password, path: p };
  } catch (_) { return null; }
}

/**
 * A short-lived CDP session on one page target, able to issue several commands.
 * The existing helpers each open a socket for a single command; a login needs a
 * handful in order, so this keeps one socket for the sequence and always closes it.
 *
 * `send` rejects on a CDP-level error. Payloads are never logged — one of them
 * carries the password.
 */
function cdpSession(wsUrl, totalTimeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') return reject(new Error('no_global_websocket_need_node22'));
    const ws = new WebSocket(wsUrl);
    let nextId = 1, closed = false;
    const pending = new Map();
    const hardStop = setTimeout(() => { try { ws.close(); } catch (_) {} }, Math.max(20000, totalTimeoutMs || 90000));
    const fail = (e) => { for (const [, p] of pending) p.reject(e); pending.clear(); };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (_) { return; }
      if (msg.id == null) return;                       // an event, not a reply
      const p = pending.get(msg.id); if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error('cdp_' + (msg.error.message || 'error')));
      else p.resolve(msg.result || {});
    };
    ws.onerror = () => { fail(new Error('cdp_ws_error')); };
    ws.onclose = () => { closed = true; clearTimeout(hardStop); fail(new Error('cdp_ws_closed')); };
    ws.onopen = () => resolve({
      send(method, params, timeoutMs) {
        if (closed) return Promise.reject(new Error('cdp_ws_closed'));
        const id = nextId++;
        return new Promise((res, rej) => {
          const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp_timeout_' + method)); }, Math.max(3000, timeoutMs || 15000));
          pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
          try { ws.send(JSON.stringify({ id, method, params: params || {} })); }
          catch (e) { clearTimeout(t); pending.delete(id); rej(e); }
        });
      },
      close() { clearTimeout(hardStop); try { ws.close(); } catch (_) {} },
    });
  });
}

// Page-side probe, run as an expression (no secrets inside it). Reports what the
// login surface currently looks like so the caller can decide: fill, or halt for a
// human. Kept deliberately conservative — anything it is not sure about is 'unknown'.
const RELOGIN_PROBE = `(function(){
  function vis(el){ if(!el) return false; var r=el.getBoundingClientRect();
    return r.width>0 && r.height>0 && getComputedStyle(el).visibility!=='hidden'; }
  function pick(sels){ for(var i=0;i<sels.length;i++){ var n=document.querySelector(sels[i]); if(vis(n)) return sels[i]; } return null; }
  var email = pick(['input[type="email"]','input[name="email"]','input[autocomplete="username"]','input[name="username"]','input[id*="email" i]']);
  var pass  = pick(['input[type="password"]','input[name="password"]','input[autocomplete="current-password"]']);
  var submit= pick(['button[type="submit"]','form button:not([type="button"])','button[data-testid*="sign" i]']);
  var text  = (document.body ? (document.body.innerText||'') : '').slice(0,4000);
  var captcha = !!(document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,[data-sitekey]'));
  var otp = !!(document.querySelector('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="code" i][maxlength]'));
  var mfaText = /two[- ]factor|verification code|authenticator|enter the code|2fa/i.test(text);
  var badCreds = /invalid login credentials|incorrect (email|password)|wrong password|credentials are invalid|email or password is incorrect/i.test(text);
  var rate = /too many (requests|attempts)|rate limit|try again later/i.test(text);
  var locked = /account (is )?(locked|suspended|disabled)|has been suspended/i.test(text);
  return JSON.stringify({ href: location.href, path: location.pathname,
    email: email, pass: pass, submit: submit,
    captcha: captcha, otp: otp, mfaText: mfaText, badCreds: badCreds, rate: rate, locked: locked });
})()`;

async function probePage(sess) {
  const r = await sess.send('Runtime.evaluate', { expression: RELOGIN_PROBE, returnByValue: true }, 12000);
  try { return JSON.parse((r.result && r.result.value) || '{}'); } catch (_) { return {}; }
}

// Focus a field by selector, then TYPE into it. Input.insertText keeps the value out
// of any evaluated source; the selector is the only thing that reaches Runtime.
async function typeInto(sess, selector, text) {
  const expr = '(function(){var n=document.querySelector(' + JSON.stringify(selector) + ');' +
    'if(!n) return false; n.focus(); try{ n.value=""; n.dispatchEvent(new Event("input",{bubbles:true})); }catch(e){} return true;})()';
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 10000);
  if (!(r.result && r.result.value === true)) throw new Error('field_not_found');
  await sess.send('Input.insertText', { text: text }, 10000);          // NEVER logged
  await sess.send('Runtime.evaluate', {
    expression: '(function(){var n=document.querySelector(' + JSON.stringify(selector) + ');' +
      'if(n){ n.dispatchEvent(new Event("input",{bubbles:true})); n.dispatchEvent(new Event("change",{bubbles:true})); } return true;})()',
    returnByValue: true,
  }, 10000);
}

/**
 * One controlled recovery attempt. Returns an outcome string; 'ok' means the browser
 * is authenticated again and the bundle has been offered to the server for its own
 * verification. Any RELOGIN_TERMINAL outcome halts recovery until an operator clears
 * agent-relogin.json.
 */
async function attemptSourceRelogin(state, reason) {
  // ── gates ─────────────────────────────────────────────────────────────────
  if (!CFG.reloginEnabled) return 'disabled';
  if (process.platform !== 'win32') return 'unsupported_platform';
  if (state.reloginInFlight) return 'already_running';
  if (state.standDownCode) return 'stood_down';            // revoked installs never log in
  if (state.isActiveSource !== true) return 'not_active_source';

  const st = readReloginState();
  if (st.haltedReason) return 'halted_' + st.haltedReason;

  const now = Date.now();
  const recent = (st.attempts || []).filter(t => now - t < RELOGIN.windowMs);
  if (recent.length >= RELOGIN.maxAttempts) {
    log('relogin_budget_exhausted', { attempts: recent.length, window_h: Math.round(RELOGIN.windowMs / 3600000) });
    await postToServer(state, { heartbeat: true, hash: null, reloginBlocked: 'budget_exhausted' }).catch(() => {});
    return 'budget_exhausted';
  }
  const lastAt = recent.length ? Math.max.apply(null, recent) : 0;
  if (lastAt && now - lastAt < RELOGIN.cooldownMs) return 'cooldown';

  const cred = readSourceCredential();
  if (!cred) {
    log('relogin_no_vault', { hint: 'run Enroll-SourceCredential.ps1 as this Windows user' });
    await postToServer(state, { heartbeat: true, hash: null, reloginBlocked: 'no_credential_vault' }).catch(() => {});
    return 'no_vault';
  }

  state.reloginInFlight = true;
  // Count the attempt BEFORE doing anything that could fail or hang, so a crash
  // mid-login still consumes budget instead of looping on the next start.
  recent.push(now);
  writeReloginState(Object.assign({}, st, { attempts: recent, lastAttemptAt: new Date(now).toISOString(), lastOutcome: 'started' }));
  log('relogin_start', { reason: reason, attempt: recent.length, of: RELOGIN.maxAttempts, account: maskAccount(cred.email) });

  let sess = null;
  const finish = (outcome, extra) => {
    const halted = RELOGIN_TERMINAL.includes(outcome);
    const cur = readReloginState();
    writeReloginState(Object.assign({}, cur, {
      lastOutcome: outcome,
      haltedReason: halted ? outcome : cur.haltedReason,
      haltedAt: halted ? new Date().toISOString() : cur.haltedAt,
    }));
    log(halted ? 'relogin_halted' : 'relogin_result', Object.assign({ outcome: outcome }, extra || {}));
    if (sess) { try { sess.close(); } catch (_) {} }
    state.reloginInFlight = false;
    return outcome;
  };

  try {
    // ── reuse the existing tab; never add a visible one ────────────────────
    const host = (() => { try { return new URL(CFG.cdpUrl).hostname; } catch (_) { return ''; } })();
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return finish('cdp_not_local');

    const listRes = await fetch(CFG.cdpUrl + '/json/list', { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!listRes || !listRes.ok) return finish('cdp_unreachable');
    const targets = await listRes.json().catch(() => []);
    let page = (Array.isArray(targets) ? targets : []).find(t =>
      t && t.type === 'page' && typeof t.url === 'string' && t.url.includes(CFG.domain));

    if (!page) {
      // Same rule nudgeTokenRotation uses: a tab is not a browser, and without one
      // an idle dedicated Chrome could never recover. Exactly one, and only when
      // none exists — so a recovery can never leave a second WriteHuman tab behind.
      const mk = await fetch(CFG.cdpUrl + '/json/new?url=' + encodeURIComponent('https://' + CFG.domain + CFG.loginPath),
        { method: 'PUT', signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!mk || !mk.ok) return finish('no_tab');
      page = await mk.json().catch(() => null);
      if (!page) return finish('no_tab');
      log('relogin_opened_tab', { reused: false });
    } else {
      log('relogin_reusing_tab', { reused: true });
    }
    if (!page.webSocketDebuggerUrl) return finish('no_ws_url');

    sess = await cdpSession(page.webSocketDebuggerUrl, RELOGIN.authWaitMs + 45000);
    await sess.send('Page.enable', {}, 8000).catch(() => {});
    await sess.send('Runtime.enable', {}, 8000).catch(() => {});

    // ── get to the official login surface ─────────────────────────────────
    let probe = await probePage(sess);
    if (!probe.email || !probe.pass) {
      await sess.send('Page.navigate', { url: 'https://' + CFG.domain + CFG.loginPath }, 20000);
      await sleep(3500);
      probe = await probePage(sess);
      // A client-hydrated SPA may need a moment more before the form exists.
      for (let i = 0; i < 4 && (!probe.email || !probe.pass); i++) { await sleep(2000); probe = await probePage(sess); }
    }

    // ── refuse to automate past a human gate ──────────────────────────────
    if (probe.captcha) return finish('captcha_required', { path: probe.path });
    if (probe.otp || probe.mfaText) return finish('mfa_required', { path: probe.path });
    if (probe.locked) return finish('account_restricted', { path: probe.path });
    if (probe.rate) return finish('rate_limited', { path: probe.path });
    if (!probe.email || !probe.pass) return finish('login_form_not_found', { path: probe.path });

    // ── fill and submit ONCE ──────────────────────────────────────────────
    await typeInto(sess, probe.email, cred.email);
    await typeInto(sess, probe.pass, cred.password);
    if (probe.submit) {
      const clicked = await sess.send('Runtime.evaluate', {
        expression: '(function(){var b=document.querySelector(' + JSON.stringify(probe.submit) + ');' +
          'if(!b) return false; b.click(); return true;})()',
        returnByValue: true,
      }, 10000);
      if (!(clicked.result && clicked.result.value === true)) return finish('submit_not_found');
    } else {
      // No button found: submit the form the password field belongs to. Still one submit.
      const sent = await sess.send('Runtime.evaluate', {
        expression: '(function(){var p=document.querySelector(' + JSON.stringify(probe.pass) + ');' +
          'var f=p&&p.form; if(!f) return false; if(f.requestSubmit) f.requestSubmit(); else f.submit(); return true;})()',
        returnByValue: true,
      }, 10000);
      if (!(sent.result && sent.result.value === true)) return finish('submit_not_found');
    }
    log('relogin_submitted', { account: maskAccount(cred.email) });

    // ── wait for the app to actually authenticate ─────────────────────────
    const deadline = Date.now() + RELOGIN.authWaitMs;
    let authed = false, last = {};
    while (Date.now() < deadline) {
      await sleep(2500);
      last = await probePage(sess).catch(() => ({}));
      if (last.badCreds) return finish('wrong_credentials');
      if (last.captcha) return finish('captcha_required');
      if (last.otp || last.mfaText) return finish('mfa_required');
      if (last.rate) return finish('rate_limited');
      if (last.locked) return finish('account_restricted');
      // The real signal: the Supabase auth cookie is back in the browser.
      const cookies = await getAllCookiesViaCDP(CFG.cdpUrl, null).catch(() => null);
      if (cookies && filterAuthCookies(cookies, CFG.domain, CFG.ref).length > 0) { authed = true; break; }
    }
    if (!authed) return finish('auth_not_confirmed', { path: last.path || null });

    // ── hand over to the EXISTING pipeline for authoritative verification ──
    // Clearing lastHash makes the next poll offer the bundle; candidateSync then
    // runs its normal provider verify + expectedAccountId match. We do not promote
    // anything ourselves, so a wrong account cannot be accepted here.
    state.lastHash = null;
    state.emptyPolls = 0;
    state.loggedOutSent = false;
    state.quickPollsLeft = Math.max(state.quickPollsLeft || 0, CFG.quickPollFor || 4);
    // NOT success yet - only the browser is authenticated. The server's accept (or
    // ACCOUNT_MISMATCH) in pushIfChanged decides, and this flag is what makes us
    // notice that verdict instead of assuming the best.
    state.reloginPending = true;
    return finish('browser_authenticated_pending_verification', { account: maskAccount(cred.email) });
  } catch (e) {
    return finish('error', { error: (e && e.message) || 'unknown' });
  }
}

/**
 * Record the SERVER's verdict on a recovery that already got the browser signed in.
 * 'wrong_account' is terminal - a machine must never keep re-signing-in an account
 * the backend refuses. Everything else is informational.
 */
function noteReloginVerdict(verdict) {
  try {
    const cur = readReloginState();
    const terminal = RELOGIN_TERMINAL.includes(verdict);
    writeReloginState(Object.assign({}, cur, {
      lastOutcome: verdict,
      lastVerdictAt: new Date().toISOString(),
      haltedReason: terminal ? verdict : cur.haltedReason,
      haltedAt: terminal ? new Date().toISOString() : cur.haltedAt,
    }));
  } catch (_) { /* status only - never fail a sync over it */ }
}

// Mask an account for logs: never the full address.
function maskAccount(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return '***';
  return s.slice(0, 1) + '****' + s.slice(at);
}


async function pushIfChanged(state) {
  state.pollCount = (state.pollCount || 0) + 1;
  // Retired by the server (revoked / uninstalled / superseded). Touch NOTHING: no cookie read, no
  // Chrome launch, and — unlike 3.4.0 — no periodic ping either. A retired installation has nothing
  // to say and nothing to ask for; the marker on disk is what a reinstall clears. Continuing to
  // call in was how a revoked machine kept a live row looking half-awake in the dashboard.
  if (state.standDown) {
    if (!state.standDownLogged) {
      state.standDownLogged = true;
      log('dormant', { code: state.standDownCode || 'DEVICE_REVOKED', note: 'run the installer again to enrol a new identity' });
    }
    return;
  }
  // An activation owns the CDP connection and the upload channel while it runs. A routine poll
  // racing it would read the same cookies, push them WITHOUT the capability, and get itself
  // answered STANDBY_ROUTINE_REFRESH — muddying the transaction for no benefit.
  if (state.activation && state.activation.running) return;
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
    //
    // ONLY ON THE ACTIVE SOURCE. This loop is what actually put WriteHuman Chrome on the wrong
    // computer: every machine with the agent installed relaunched its own dedicated Chrome every
    // couple of minutes, forever, whether or not it was supplying the session — a revoked box on
    // the operator's desk did it for hours. A standby has no reason to have Chrome running at all,
    // so it no longer starts one. `isActiveSource` is undefined until the first reply, and that
    // first poll is a heartbeat, so a fresh agent simply waits to be told.
    if (CFG.autoLaunchChrome && state.isActiveSource === true
        && state.cdpFails >= CFG.cdpRelaunchAfter && (monoNow() - (state.lastRelaunchAt || 0)) > CFG.relaunchCooldownMs) {
      state.lastRelaunchAt = monoNow();
      relaunchChrome('cdp_auto');
    }
    await postToServer(state, { heartbeat: true, hash: null }); // report CDP-down so the dashboard sees it live
    return;
  }

  // TOKEN ROTATION, ON TIME. The server tells the ACTIVE SOURCE (and only it) how long the stored
  // access token has left; when that is short, reload the WriteHuman tab so the app rotates now
  // instead of whenever a throttled background timer gets round to it. Cooldown-gated so a run of
  // polls inside the same window cannot reload in a loop.
  if (state.isActiveSource === true && state.rotateTokenIn != null
      && (monoNow() - (state.lastNudgeAt || 0)) > Math.max(120000, CFG.relaunchCooldownMs)) {
    await nudgeTokenRotation(state, 'token_ttl_' + state.rotateTokenIn + 's');
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
        // CONFIRMED logout — and only here. Reaching this line means the auth cookie
        // has been absent for CFG.logoutDebounce consecutive polls AND this browser
        // was authenticated before (state.lastHash !== null, checked by the branch
        // above), so an inconclusive read, a CDP outage or a closed Chrome can never
        // trigger recovery. Every other gate (opt-in, active source, budget,
        // cooldown, persistent halt, single flight) lives in attemptSourceRelogin.
        // Awaited deliberately: the single-flight flag plus the tick's own sequencing
        // are what stop two recoveries overlapping.
        if (CFG.reloginEnabled) {
          const outcome = await attemptSourceRelogin(state, 'auth_cookie_absent').catch((e) => 'error_' + ((e && e.message) || ''));
          // 'ok' cleared lastHash, so the next poll offers the recovered bundle and
          // the server performs the authoritative identity verification.
          if (outcome === 'ok') return;
        }
      } else if (heartbeatDue(state)) {
        state.lastHeartbeatAt = monoNow();
        await postToServer(state, { heartbeat: true, hash: null });
        log('browser_not_authenticated', { auth_cookies: 0, empty_polls: state.emptyPolls });
      }
    } else if (heartbeatDue(state)) {
      state.lastHeartbeatAt = monoNow();
      await postToServer(state, { heartbeat: true, hash: null });
      log('browser_not_authenticated', { auth_cookies: 0 });
    }
    return;
  }
  state.emptyPolls = 0; state.loggedOutSent = false;
  // A resync simply clears lastHash, so an unchanged bundle is re-offered on the next poll. There
  // is no client-side force flag any more: the server decides what an offer is worth, we only make
  // it. (The old flag let any agent bypass the standby rule by putting a boolean in its own body.)
  if (hash === state.lastHash) {
    // Nothing changed. Asking Chrome was free (loopback); telling the SERVER so is not, and this
    // runs on a host that has hit its process ceiling. So a no-change poll only reaches the network
    // when a heartbeat is actually due - at a 45s poll and a 3-minute heartbeat that is one request
    // in four. Liveness is unaffected: the dashboard's staleness window is far wider than 3 minutes.
    const due = heartbeatDue(state);
    if (!due) return;
    state.lastHeartbeatAt = monoNow();
    const r = await postToServer(state, { heartbeat: true, hash: hash.slice(0, 8) });
    if (r && r._err) log('heartbeat_failed', { error: r._err });
    else if (r && r._status) log('heartbeat_rejected', { status: r._status });
    else log('heartbeat', { hash: hash.slice(0, 8) });
    return;
  }
  const r = await postToServer(state, { cookies: auth });
  if (r && r._err) { log('ingest_post_failed', { error: r._err }); return; }     // lastHash is still cleared → retried next tick
  if (r && r._status) {
    // A REFUSED candidate is a real outcome, not a transport failure: record the server's reason
    // and stop re-offering the same bundle, or the agent would push a rejected candidate forever.
    // STALE_BUNDLE in particular is normal and healthy — it just means another device is ahead.
    const code = (r.body && r.body.code) || r.code || null;
    if (code === 'STALE_BUNDLE' || code === 'ACCOUNT_MISMATCH' || code === 'REPLAY_REJECTED') state.lastHash = hash;
    log('ingest_rejected', { status: r._status, code, token_exp: authTokenExpiry(auth, CFG.ref) });

    // ── a recovery awaiting its verdict was REJECTED ──────────────────────────
    // attemptSourceRelogin() only ever reports that the BROWSER re-authenticated;
    // the account's identity is decided here, by the server. ACCOUNT_MISMATCH means
    // we signed a DIFFERENT account in, so the recovery was not a success at all:
    // halt permanently rather than leaving a wrong account logged in and retrying.
    if (state.reloginPending) {
      state.reloginPending = false;
      if (code === 'ACCOUNT_MISMATCH') {
        noteReloginVerdict('wrong_account');
        log('relogin_rejected_by_server', { code: code, action: 'halted' });
        return;
      }
      noteReloginVerdict('unconfirmed_' + (code || 'rejected'));
      log('relogin_unconfirmed', { code: code });
      return;
    }

    // ── PROVIDER-CONFIRMED logout, with the cookies still present ─────────────
    // The second genuine-logout shape: Chrome still holds an auth cookie, but the
    // provider itself says the session is dead (candidateSync verified it and
    // answered SESSION_EXPIRED). That is a conclusive verdict from the real
    // provider, not a guess, so it is a legitimate recovery trigger.
    //
    // VERIFICATION_INCONCLUSIVE, STALE_BUNDLE, REPLAY_REJECTED and every transport
    // error are deliberately NOT triggers: inconclusive means unknown, and the other
    // two mean another device is ahead or the offer was a duplicate - none of them is
    // evidence that this browser is logged out.
    if (CFG.reloginEnabled && code === 'SESSION_EXPIRED') {
      await attemptSourceRelogin(state, 'provider_session_expired').catch(() => {});
    }
    return;
  }
  state.lastHash = hash;
  state.lastHeartbeatAt = monoNow();   // a push IS contact; no extra beat needed right after
  // A genuine change happened — poll faster for a short window to catch the follow-up rotation.
  state.quickPollsLeft = CFG.quickPollFor;
  // The server ACCEPTED the bundle, which means candidateSync completed its
  // provider-authenticated verify AND its expectedAccountId match. Only now is a
  // recovery actually complete - this is the one place that may call it confirmed.
  if (state.reloginPending) {
    state.reloginPending = false;
    noteReloginVerdict('confirmed');
    log('relogin_confirmed', { promoted: r.promoted === true, result: r.code || r.result || null });
  }
  log('cookie_synchronized', {
    hash: hash.slice(0, 8), changed: r.changed, result: r.code || r.result,
    token_exp: authTokenExpiry(auth, CFG.ref),
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
  // ── FIRST: has this installation been retired? ─────────────────────────────
  // Checked before the identity, before the config, before anything touches Chrome. A revoked,
  // uninstalled or superseded installation must come up dormant and stay dormant — the failure it
  // replaces is an agent that went quiet until the next logon and then started polling (and
  // relaunching its own browser) all over again with a credential the server had already refused.
  const retired = readStandDown();
  if (retired && !/^(1|true|yes)$/i.test(String(process.env.WHV2_CLEAR_STAND_DOWN || ''))) {
    log('dormant', {
      code: retired.code || 'DEVICE_REVOKED', since: retired.at || null, device_id: retired.deviceId || null,
      remedy: 'Run the WriteHuman Agent installer again — it archives this dead identity and starts a fresh authorization.',
      marker: CFG.standDownFile,
    });
    releaseLock();
    process.exit(0);
  }

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

  const state = { device, lastHash: null, startedAt: monoNow(), pollCount: 0, authCount: 0, cdp: null, chrome: false, lastError: null, errorCount: 0, lastErrorMsg: null, lastErrorAt: null, emptyPolls: 0, loggedOutSent: false, stopped: false, cdpFails: 0, ingestFails: 0, lastRelaunchAt: 0, lastDelay: 0, quickPollsLeft: 0 };
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

module.exports = { isAuthName, domainMatches, filterAuthCookies, hashAuthCookies, authTokenExpiry, getAllCookiesViaCDP, buildReport, canonicalPath, samePath, AGENT_VERSION, CFG, handleCommand, postToServer, applyDirectives, heartbeatDue, monoNow,
  // 3.5.3 source-side recovery - exported for tests (the file self-starts only
  // under require.main, so a test can require it without launching the agent).
  attemptSourceRelogin, noteReloginVerdict, readReloginState, writeReloginState, readSourceCredential, reloginReport, maskAccount, reloginStatePath, RELOGIN, RELOGIN_TERMINAL };

if (require.main === module) start();
