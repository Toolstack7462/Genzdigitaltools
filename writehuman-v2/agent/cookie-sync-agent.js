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
// 3.5.5 — optional guarded account-wide session-limit reset on the official provider login screen.
//          Strict origin and visible-control checks, one reset / 24 hours, no login loops.
// 3.5.4 — recovery hardening: exact origin, startup logout, multi-step, verified server result.
// 3.5.3 — SOURCE-SIDE AUTOMATIC RE-LOGIN (opt-in, WHV2_RELOGIN=1). On a CONFIRMED logout of
//         this machine's own source account, sign back in through WriteHuman's normal login page
//         in the tab that is already open, once, using a DPAPI CurrentUser credential readable
//         only by this Windows user; then let the existing sync pipeline verify and promote it.
//         Never touches the refresh token, never adds a visible tab, and halts for MFA / CAPTCHA /
//         wrong password / rate limit / restriction / wrong account.
// 3.5.2 — the success log no longer throws (`forced is not defined` hid every successful sync as a
//         tick_error), and each push / refusal logs the candidate token's EXPIRY TIME (never the
//         token), so a run of refusals shows whether Chrome had actually rotated.
// 3.5.6: page-aware recovery; independent liveness; visible same-form selection;
// already-filled form support; CDP connection rejection and guarded DOM handles.
// 3.5.7: bounded homepage Login entry navigation and idle unknown-state recheck.
// 3.5.9: official Too many active sessions dialog support, including Sign out all other sessions;
//        distinguish individual session Sign out buttons from signed-in account proof.
// 3.5.8: stable login SPA wait; passive CAPTCHA markup not mistaken for human challenge;
//        authoritative active-source directives preserved on sparse acknowledgements.
const AGENT_VERSION = '3.5.15'; // Source release candidate; Windows/live acceptance still required.
const AGENT_BUILD_ID = '3.5.15-retry-rc1';

// Single-source config: an optional config.json (non-secret settings, shared with the watchdog) is
// read as a fallback; ENV always takes precedence, so a service manager / run-agent.cmd can override.
// The AGENT KEY is read from ENV or a locked-down key FILE (WHV2_AGENT_KEY_FILE) — never from the
// shared config.json — so the secret isn't sitting in a world-readable launcher/config.
function readJsonFile(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; } }
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
    const ps = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$b=[IntPtr]::Zero;try{$s=Get-Content -Raw -LiteralPath '" + String(p).replace(/'/g,"''") + "'" +
      ';$ss=ConvertTo-SecureString $s.Trim();' +
      '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss);' +
      '[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)}catch{""}finally{if($b -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}}';
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

const LOCAL_REVIEW_MODE=(process.argv||[]).slice(2).some(x=>['--acknowledge-resolved-challenge','--authorize-session-limit-recovery','--connection-check','--diagnostics','--recovery-diagnostics'].includes(String(x).toLowerCase()));
const CFG = {
  ingestUrl: pick('WHV2_INGEST_URL', 'ingestUrl', 'http://127.0.0.1:3100/v2/cookies/ingest'),
  // Shared ingest key, in order of preference: env (service manager), DPAPI-protected file
  // (what the installer writes), then a plaintext key file (fallback for non-Windows or when
  // PowerShell is unavailable). Never read from config.json - that file is not a secret store.
  agentKey: LOCAL_REVIEW_MODE?'':process.env.WHV2_AGENT_KEY
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
  reloginEnabled: /^(1|true|yes)$/i.test(String(pick('WHV2_RELOGIN', 'reloginEnabled', '')).trim()),
  // HIGH-IMPACT: clicking the provider's 'Sign out all' revokes every session for
  // this account. OFF by default, even when ordinary auto-relogin is enabled.
  sessionLimitSignOutAll: /^(1|true|yes)$/i.test(String(pick('WHV2_SESSION_LIMIT_SIGNOUT_ALL', 'sessionLimitSignOutAll', '')).trim()),
  sessionLimitLiveAuthorizationUntil: pick('WHV2_SESSION_LIMIT_AUTHORIZED_UNTIL', 'sessionLimitLiveAuthorizationUntil', ''),
  sessionLimitConsent: pick('WHV2_SESSION_LIMIT_CONSENT', 'sessionLimitConsent', ''),
  // WriteHuman's own login surface. Matches the SIGNIN_PATH the backend registry
  // already uses for this tool, and is overridable if the app ever moves it.
  // Inspect only the source tab; never a customer browser. No credential values are read.
  reloginPageCheckMs: Math.max(5000, parseInt(pick('WHV2_RELOGIN_PAGE_CHECK_MS', 'reloginPageCheckMs', ''), 10) || 45000),
  // An unknown, idle page may be reloaded at most once per interval; never per tick.
  reloginPageRecheckMs: Math.max(300000, parseInt(pick('WHV2_RELOGIN_PAGE_RECHECK_MS', 'reloginPageRecheckMs', ''), 10) || 600000),
  reloginUseBrowserAutofill: !/^(0|false|no)$/i.test(pick('WHV2_RELOGIN_AUTOFILL', 'reloginUseBrowserAutofill', 'true')),
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
  const temp=CFG.deviceStateFile+'.'+process.pid+'.tmp';
  try {
    const fd=fs.openSync(temp,'w',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(st,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,CFG.deviceStateFile);
    return true;
  } catch (_) {try{fs.unlinkSync(temp);}catch(_){}log('device_state_write_failed', { code:'identity_write_failed' }); return false; }
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

  // Authorization handoff is interactive UI, never a console log/redirected file.
  log('enroll_waiting', { authorize_url: start.authorizeUrl, expires_at: start.expiresAt });
  if(process.stdout?.isTTY===true&&typeof start.authorizeUrl==='string')
    process.stdout.write('\nAuthorize this device by opening:\n'+start.authorizeUrl+'\n');
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
// Allowlist values rather than trying to redact arbitrary provider/exception text.
// Unknown strings are omitted, including paths, page text, account names and URLs.
const SAFE_CODES = new Set(('MONITORING LOGIN_REQUIRED PAGE_RECHECK RELOAD_ONCE LOGIN_CONTROL_FOUND NAVIGATION FORM_READY EMAIL_SUBMITTED LOGIN_SUBMITTED BROWSER_CANDIDATE BACKEND_VERIFIED SYNC_RESUMED FAILED MANUAL_ACTION VERIFY_PENDING ' +
  'SESSION_CHECK LOGIN_UI_MISSING PAGE_RELOAD_REQUESTED PAGE_RELOAD_COMPLETED LOGIN_CLICKED LOGIN_FORM_READY CREDENTIALS_AVAILABLE PROVIDER_AUTHENTICATED BACKEND_VERIFICATION_PENDING BACKEND_VERIFICATION_REJECTED RECOVERY_FAILED RECOVERY_RETRY_ELIGIBLE MANUAL_INTERVENTION_REQUIRED RECOVERY_BLOCKED RETRY_WAIT page_reload_timeout page_wait_timeout recovery_deadline_exceeded multiple_approved_tabs loading session_limit page_wait_completed page_wait_timeout reload_wait ' +
  'PROMOTED COOKIE_BUNDLE_UNCHANGED VERIFICATION_INCONCLUSIVE SESSION_EXPIRED ACCOUNT_MISMATCH STALE_BUNDLE REPLAY_REJECTED STANDBY_ROUTINE_REFRESH DEVICE_REVOKED DEVICE_UNINSTALLED DEVICE_SUPERSEDED ' +
  'unknown unavailable authenticated login_required login_entry editor_busy confirmed disabled enabled started clicked pending operational_error transport_error ' +
  'wrong_credentials mfa_required captcha_required rate_limited account_restricted wrong_account state_unreadable state_unwritable ' +
  'session_limit_requires_manual_reset session_limit_live_authorization_required session_limit_control_unverified session_limit_reset_budget_exhausted session_limit_reset_failed session_limit_after_reset ' +
  'source_not_authorized activation_in_progress already_authenticated verification_pending source_page_busy no_tab no_vault login_form_not_found password_form_not_found ' +
  'cdp_not_local cdp_unreachable cdp_discovery_failed cdp_chrome_too_old cdp_cookie_read_failed cdp_read_failed untrusted_cdp_page unapproved_login_origin unapproved_form_action ambiguous_login_form invalid_login_config ' +
  'field_not_found_or_bad_origin field_set_failed login_form_changed submit_not_found submit_still_disabled source_page_changed login_entry_changed login_navigation_failed ' +
  'relogin_state_unwritable cdp_ws_error cdp_ws_closed cdp_connect_timeout cdp_session_timeout cdp_command_failed cdp_command_timeout recovery_exception ' +
  'auth_not_confirmed submission_outcome_unknown browser_authenticated_pending_verification budget_exhausted cooldown no_logout_evidence ' +
  'visible_login_entry visible_login_form provider_session_expired auth_cookie_absent startup_auth_cookie_absent ' +
  'reload_requested reload_already_used login_control_clicked login_page_requested existing_form browser_autofill local_vault ' +
  'deadline_reached missing_start_time unconfirmed_verification_timeout unconfirmed_visible_logout rejected response ' +
  'deferred_unsafe_browser_state deferred_page_changed deferred_inspection_failed reloaded reload_failed no_profile_proof wrong_chrome_profile ' +
  'not_active_source stood_down already_running unsupported_platform loopback_only identity_write_failed rotation_already_reserved challenge_review_acknowledged captcha_halt_revalidated captcha_recheck_deferred captcha_review_required').split(/\s+/));
function safeCode(value) {
  if (typeof value !== 'string') return null;
  if (SAFE_CODES.has(value)) return value;
  for (const prefix of ['unconfirmed_', 'halted_']) if (value.startsWith(prefix) && SAFE_CODES.has(value.slice(prefix.length))) return value;
  return null;
}
function safeLogFields(fields) {
  const out = {};
  const numeric = new Set(['attempt','of','duration_ms','stage_duration_ms','attempt_count','polls','observations','status','consecutive','count_24h','auth_cookies','errorCount','poll_ms','next_ms','ingest_fails','repeated','transient_errors','samples']);
  const booleans = new Set(['manual_required','recovery','promoted','same_tab','reused','global','enabled','pendingVerification','is_active_source','changed','reloaded','document_changed','page_ready']);
  const codes = new Set(['stage','event','reason','outcome','code','action','result','state','source']);
  for (const [k,v] of Object.entries(fields || {})) {
    if (numeric.has(k) && Number.isFinite(v)) out[k] = v;
    else if (booleans.has(k) && typeof v === 'boolean') out[k] = v;
    else if (codes.has(k) && safeCode(v)) out[k] = safeCode(v);
    else if (k === 'incident_id' && /^[a-f0-9-]{36}$/.test(String(v))) out[k] = v;
    else if (k === 'next_retry_at' && typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)) out[k] = v;
  }
  return out;
}
const logRepeats = new Map();
function log(event, fields) {
  try {
    if (!/^[a-z][a-z0-9_]{0,70}$/.test(event)) return;
    const clean=safeLogFields(fields), key=event+JSON.stringify(clean), now=monoNow();
    const old=logRepeats.get(key);
    if (old && now-old.at<60000) { old.count++; return; }
    if (old && old.count) clean.repeated=old.count;
    if(logRepeats.size>=100)logRepeats.delete(logRepeats.keys().next().value);
    logRepeats.set(key,{at:now,count:0});
    console.log(`[${new Date().toISOString()}] [wh-v2-agent] ${event} ${JSON.stringify({...clean,version:AGENT_VERSION,build_id:AGENT_BUILD_ID})}`);
  } catch (_) {}
}

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
  state.lastErrorMsg = safeCode(msg) || 'operational_error';
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

async function getAllCookiesViaCDP(cdpUrl, state, inspectOnly=false) {
  if(state){state.cdp='DOWN';state.chrome=false;state.cookieReadOk=false;state.profile=null;}
  // CDP must never be reached over anything but loopback. The debug port is unauthenticated: every
  // cookie in the profile is readable by whoever can connect, so a non-loopback endpoint would mean
  // the session is exposed to the network. Refuse rather than warn.
  const host = (() => { try { return new URL(cdpUrl).hostname; } catch (_) { return ''; } })();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('cdp_not_local');
  }

  let verRes;
  try{verRes=await fetch(cdpUrl + '/json/version', { signal: AbortSignal.timeout(8000) });}
  catch(_){throw new Error('cdp_unreachable');}
  if(state)state.cdp='ERROR'; // HTTP answered; this alone does not prove a Chrome endpoint.
  if (!verRes.ok) throw new Error('cdp_discovery_failed');
  let ver;try{ver=await verRes.json();}catch(_){throw new Error('cdp_discovery_failed');}
  if(!ver||typeof ver!=='object'||!/(?:Chrome|Chromium)\/\d+\./.test(String(ver.Browser||'')))throw new Error('cdp_discovery_failed');
  if(state)state.chrome=true;

  // Protocol compatibility: Storage.getCookies on the BROWSER target needs a modern Chrome. An old
  // build fails deep inside the websocket with an opaque error; naming it here saves the diagnosis.
  const proto = String(ver['Protocol-Version'] || '');
  const major = Number(String(ver.Browser || '').match(/\/(\d+)\./)?.[1] || 0);
  if (state) { state.cdpProtocol = proto || null; state.chromeMajor = major || null; }
  if (major && major < 90) throw new Error('cdp_chrome_too_old');

  const dir = ver.userDataDir || ver['user-data-dir'] || '';
  const wsUrl = ver.webSocketDebuggerUrl;
  if (!isApprovedCdpSocket(wsUrl, 'browser', cdpUrl)) throw new Error('untrusted_cdp_page');
  const sess=await cdpSession(wsUrl,20000);
  if(state)state.cdp='200'; // Connection is established even if the profile guard refuses access.
  try {
    if (CFG.chromeProfile && dir && !samePath(dir, CFG.chromeProfile)) throw new Error('wrong_chrome_profile');
    if(CFG.chromeProfile&&!dir){
      let args=[];
      try { args=(await sess.send('Browser.getBrowserCommandLine',{},5000)).arguments||[]; }catch(_){}
      const profile=chromeArgument(args,'--user-data-dir');
      if(profile&&!samePath(profile,CFG.chromeProfile))throw new Error('wrong_chrome_profile');
      if(!profile&&!windowsProfileProof(cdpUrl))throw new Error('no_profile_proof');
    }
    if(state)state.profile=CFG.chromeProfile?'configured-profile-verified':'profile-not-configured';
    if(inspectOnly)return null; // Diagnostic mode never reads cookies or a password/vault.
    const result=await sess.send('Storage.getCookies',{},10000);
    if(!Array.isArray(result.cookies))throw new Error('cdp_cookie_read_failed');
    if(state)state.cookieReadOk=true;
    return result.cookies;
  }finally{sess.close();}
}

function recordCdpFailure(state,error){
  state.cookieReadOk=false;
  const reason=safeCode(error?.message)||'cdp_read_failed';
  state.lastError=reason;state.cdpFails=(state.cdpFails||0)+1;
  recordError(state,reason);
  log('cdp_read_failed',{reason,consecutive:state.cdpFails});
  return reason;
}

async function connectionStatus(){
  const state={};let reason=null;
  try{await getAllCookiesViaCDP(CFG.cdpUrl,state,true);}catch(error){reason=safeCode(error?.message)||'cdp_read_failed';}
  return {schema:1,version:AGENT_VERSION,cdp:state.cdp,chrome:state.chrome,
    profileConfigured:!!CFG.chromeProfile,profileVerified:state.profile==='configured-profile-verified',
    reason,autoLaunchConfigured:CFG.autoLaunchChrome,launcherConfigured:!!CFG.chromeLauncher,
    launcherFilePresent:CFG.chromeLauncher?fs.existsSync(CFG.chromeLauncher):null,
    cookieReadPerformed:false,loginState:'not_checked'};
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
 * Never launches Chrome or opens a new tab. Missing approved tabs are left untouched.
 */
async function nudgeTokenRotation(state, reason) {
  if (state.reloginInFlight || state.reloginPending || state.standDown || state.standDownCode || state.isActiveSource !== true) return false;
  const cdpUrl = CFG.cdpUrl;
  const host = (() => { try { return new URL(cdpUrl).hostname; } catch (_) { return ''; } })();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return false;
  try {
    const listRes = await fetch(cdpUrl + '/json/list', { signal: AbortSignal.timeout(6000) });
    if (!listRes.ok) return false;
    const targets = await listRes.json();
    const page = findApprovedWriteHumanTab(targets);

    if (!page) { log('token_nudge',{reason,action:'no_tab'}); return false; }
    if (!page.webSocketDebuggerUrl || typeof WebSocket === 'undefined') return false;

    // The source tab can contain unsaved user text. Freshly inspect the actual
    // approved document before triggering token rotation; never trust the last
    // heartbeat's cached browser-state label. A second probe closes the race
    // with typing that begins while the first CDP operation is in progress.
    let sess;
    let ok = false;
    try {
      if (!isApprovedCdpPageSocket(page.webSocketDebuggerUrl)) return false;
      sess = await cdpSession(page.webSocketDebuggerUrl, 20000);
      const safeToReload = p =>
        isApprovedWriteHumanUrl(p.href) && p.pageReady === true && (p.authenticated === true || p.editorPresent === true) &&
        p.editorBusy === false && p.loginEvidence !== true && p.loginEntryEvidence !== true &&
        p.sessionLimit !== true && !recoveryBlock(p);
      const initial = await probePage(sess);
      if (!safeToReload(initial) || state.reloginInFlight || state.reloginPending || state.isActiveSource !== true) {
        log('token_nudge', { reason, action:'deferred_unsafe_browser_state' });
        state.lastNudgeAt = monoNow();
        return false;
      }
      const current = await probePage(sess);
      if (!safeToReload(current) || state.reloginInFlight || state.reloginPending || state.isActiveSource !== true) {
        log('token_nudge', { reason, action:'deferred_page_changed' });
        state.lastNudgeAt = monoNow();
        return false;
      }
      const rotationHash=hashAuthCookies(filterAuthCookies(await getAllCookiesViaCDP(cdpUrl,null),CFG.domain,CFG.ref));
      const finalProbe=await probePage(sess);
      if(!safeToReload(finalProbe)||state.reloginInFlight||state.reloginPending||state.standDown||state.standDownCode||state.isActiveSource!==true)return false;
      const saved=readReloginState();
      const sameBundle=saved.lastRotationHash===rotationHash;
      const attempts=sameBundle?saved.lastRotationAttempts:0;
      const lastAt=Date.parse(saved.lastRotationAt);
      const directiveAge=monoNow()-state.rotationDirectiveAt;
      const freshExpiry=Number.isFinite(state.rotationDirectiveAt)&&Number.isFinite(state.rotateTokenIn)&&state.rotateTokenIn<=0&&
        Number.isFinite(directiveAge)&&directiveAge>=0&&directiveAge<=Math.max(120000,CFG.pollMs*2);
      const retryDue=Number.isFinite(lastAt)&&Date.now()-lastAt>=Math.max(120000,CFG.relaunchCooldownMs);
      if(!rotationHash||saved.haltedReason==='state_unreadable'||(sameBundle&&(attempts>=2||!freshExpiry||!retryDue))){
        state.lastNudgeAt=monoNow();log('token_nudge',{reason,action:'rotation_already_reserved'});return false;
      }
      // A pre-expiry reload may leave the bundle unchanged. Permit at most one
      // later retry after a fresh server expiry and persisted minimum interval.
      // Reserve before sending, including when a restart or lost reply follows.
      if(!writeReloginState({...saved,lastRotationHash:rotationHash,lastRotationAttempts:attempts+1,lastRotationAt:new Date().toISOString()}))return false;
      await sess.send('Page.reload', { ignoreCache:false }, 8000);
      ok = true;
    } catch (_) {
      log('token_nudge', { reason, action:'deferred_inspection_failed' });
      state.lastNudgeAt = monoNow();
      return false;
    } finally { if (sess) sess.close(); }
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


// SECURITY: never treat a substring hostname as the official login domain.
// In particular evil-writehuman.ai.example.com is NOT writehuman.ai.
function isApprovedWriteHumanUrl(href) {
  try {
    const u = new URL(String(href || ''));
    return String(CFG.domain).toLowerCase() === 'writehuman.ai'
      && u.protocol === 'https:' && u.hostname.toLowerCase() === 'writehuman.ai'
      && (u.port === '' || u.port === '443') && !u.username && !u.password;
  } catch (_) { return false; }
}
function findApprovedWriteHumanTab(targets) {
  return (Array.isArray(targets) ? targets : []).find(t =>
    t && t.type === 'page' && isApprovedWriteHumanUrl(t.url));
}
function isApprovedCdpSocket(raw,kind,baseUrl=CFG.cdpUrl) {
  try {
    const u=new URL(raw),base=new URL(baseUrl);
    return u.protocol==='ws:'&&!u.username&&!u.password&&!u.search&&!u.hash
      && ['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname)
      && String(u.port||'80')===String(base.port||'80')
      && new RegExp('^/devtools/'+kind+'/[A-Za-z0-9_-]+$').test(u.pathname);
  }catch(_){return false;}
}
function isApprovedCdpPageSocket(raw){return isApprovedCdpSocket(raw,'page');}
function chromeArgument(args,name){
  if(!Array.isArray(args))return '';
  const exact=args.indexOf(name);if(exact>=0)return String(args[exact+1]||'');
  const arg=args.find(x=>typeof x==='string'&&x.startsWith(name+'='));return arg?arg.slice(name.length+1):'';
}
function windowsProfileProof(cdpUrl){
  if(process.platform!=='win32')return false;
  try{
    // Read process metadata only. Do not inspect password stores or terminate Chrome.
    const ps="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object {$_.CommandLine -and $_.CommandLine -match '--remote-debugging-port='} | Select-Object -ExpandProperty CommandLine) | ConvertTo-Json -Compress";
    const raw=require('child_process').execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',windowsHide:true,timeout:10000});
    const parsed=JSON.parse(raw),lines=Array.isArray(parsed)?parsed:[parsed];
    const port=new URL(cdpUrl).port||'80';
    const matches=lines.filter(line=>{
      if(typeof line!=='string')return false;
      // Child processes can inherit browser switches but cannot prove ownership
      // of the browser endpoint. Ignore them before testing for ambiguity.
      if(/(?:^|\s)"?--type(?:=|\s|"?$)/.test(line))return false;
      const p=line.match(/(?:^|\s)(?:"--remote-debugging-port=(\d+)"|--remote-debugging-port="(\d+)"|--remote-debugging-port=(\d+))(?=\s|$)/);
      return p&&(p[1]||p[2]||p[3])===port;
    });
    if(matches.length!==1)return false;
    const m=matches[0].match(/(?:^|\s)(?:"--user-data-dir=([^"\r\n]+)"|--user-data-dir="([^"\r\n]+)"|--user-data-dir=([^\s"]+))(?=\s|$)/);
    return !!m&&samePath(m[1]||m[2]||m[3],CFG.chromeProfile);
  }catch(_){return false;}
}

function cdpNewTabUrl(target) {
  // Chrome DevTools discovery API: PUT /json/new?<url> (not ?url=<url>).
  return CFG.cdpUrl + '/json/new?' + encodeURIComponent(target);
}

// Diagnostics report attached to EVERY server call (drives the dashboard).
function buildReport(state) {
  // Omit an unknown count completely. The deployed legacy sanitizer turns an
  // explicit null into Number(null) === 0, falsely marking the device signed out.
  const known=state.cookieReadOk===true&&!state.reloginPending&&state.lastBrowserState!=='browser_candidate';
  return {
    cdp: state.cdp, chrome: state.chrome, pollCount: state.pollCount,
    // Provider-login screen proves that available cookie bytes are not an
    // authenticated session. The backend currently interprets authCookies>0 as
    // authenticated-device telemetry, so never report a stale positive count.
    ...(known?{authCookies:state.browserLogoutObserved||['login_required','login_entry'].includes(state.lastBrowserState)?0:(state.authCount||0)}:{}),
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
    relogin: Object.assign(reloginReport(), {
      browserState: state.lastBrowserState || 'unknown', pendingVerification: !!state.reloginPending,
      // Raw cookie presence is a count, NOT account-authentication evidence.
      rawAuthCookieCount: state.cookieReadOk===true?(state.authCount||0):null,
    }),
  };
}

// Non-secret snapshot of the recovery budget / halt state for the dashboard.
function reloginReport() {
  try {
    if (!CFG.reloginEnabled) return { enabled:false,sessionLimitSignOutAll:!!CFG.sessionLimitSignOutAll,activeBlock:'disabled',retryEligible:false,nextRetryAt:null };
    const st = readReloginState();
    const now = Date.now();
    const recent = (st.attempts || []).filter(t => now - t < RELOGIN.windowMs);
    const eligibleAt=recent.length?Math.max(Math.max(...recent)+RELOGIN.cooldownMs,
      recent.length>=RELOGIN.maxAttempts?recent.slice().sort((a,b)=>a-b)[recent.length-RELOGIN.maxAttempts]+RELOGIN.windowMs:0):0;
    const activeBlock=st.haltedReason?safeCode(st.haltedReason)||'state_unreadable':st.pendingVerification?'verification_pending':
      st.incident?.credentialSubmitted&&!st.incident.closed?'submission_outcome_unknown':
      recent.length>=RELOGIN.maxAttempts?'budget_exhausted':eligibleAt>now?'cooldown':null;
    return {
      enabled: true,
      hasCredential: !!readSourceCredentialPresence(),
      sessionLimitSignOutAll: !!CFG.sessionLimitSignOutAll,
      sessionLimitResetsLast24h: (st.sessionLimitResets || []).filter(t => now - t < 86400000).length,
      attemptsInWindow: recent.length,
      maxAttempts: RELOGIN.maxAttempts,
      windowMs:RELOGIN.windowMs,cooldownMs:RELOGIN.cooldownMs,reloadWaitMs:RELOGIN.reloadWaitMs,
      activeBlock,retryEligible:activeBlock===null,
      eligibilityScope:'local_recovery_gates_only',
      haltedReason: st.haltedReason ? safeCode(st.haltedReason)||'state_unreadable' : null,
      haltedAt: safeTimestamp(st.haltedAt),
      lastOutcome: safeCode(st.lastOutcome),
      lastAttemptAt: safeTimestamp(st.lastAttemptAt),
      manualRequired: !!st.haltedReason,
      browserAutofillAllowed: !!CFG.reloginUseBrowserAutofill,
      nextRetryAt: ['budget_exhausted','cooldown'].includes(activeBlock)&&eligibleAt>now?new Date(eligibleAt).toISOString():null,
    };
  } catch (_) { return { enabled: !!CFG.reloginEnabled }; }
}
function safeTimestamp(value){
  return typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
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
  // A successful idempotent response may omit the source directive. Omission
  // is NOT demotion; an explicit false still revokes local source authority.
  if (body && typeof body.isActiveSource === 'boolean') state.isActiveSource = body.isActiveSource;
  state.superseded = !!(body && body.superseded);
  // The server's canonical verdict on what this machine IS (READY / ACTIVE / STANDBY / …). Kept
  // in telemetry so a disagreement between "what the box thinks it is" and "what the server
  // thinks it is" becomes visible — that disagreement is the shape of every wrong-machine bug
  // this system has had.
  if (body && typeof body.deviceState === 'string') state.deviceState = body.deviceState;
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
  state.rotationDirectiveAt = Number.isFinite(state.rotateTokenIn) ? monoNow() : null;
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
    envelope.idempotencyKey = (dev.deviceId||dev.agentId) + ':' + dev.seq;
    if(!saveDeviceState(dev))return {_err:'identity_write_failed'};
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
      if(state.reloginInFlight||state.reloginPending){
        state.pendingAck={commandId:cmd.id,nonce:cmd.nonce,ok:false,result:'recovery_in_progress'};
        return;
      }
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
    state.cdp='DOWN';state.chrome=false;state.cookieReadOk=false;
    try {
      cookies = await getAllCookiesViaCDP(CFG.cdpUrl, state);
      state.cdp = '200'; state.chrome = true; state.cdpFails = 0;state.cookieReadOk=true;
    } catch (e) {
      const reason=recordCdpFailure(state,e);
      if(reason!=='cdp_unreachable')return giveUp('CHROME_INSPECTION_FAILED','Chrome inspection failed: '+reason+'. Review local connection diagnostics.');
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
 * ORIGINAL COOKIE-ABSENCE TRIGGER (also supports repeated visible-login evidence): the Supabase auth cookie has been absent for
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
 * a guarded DOM-object call over loopback CDP to our own browser. Values are
 * separate arguments, never interpolated into evaluated JavaScript or logged.
 *
 * SAFETY RAILS. Opt-in (off unless WHV2_RELOGIN=1); active source only; single
 * flight; bounded attempts inside a rolling window; cooldown between attempts;
 * state persisted so a restart cannot reset the budget; and a PERSISTENT HALT on
 * anything a machine must not retry — wrong password, MFA, CAPTCHA, rate limit,
 * account restriction, wrong account. Legacy/uncertain halts require an operator.
 * A proven pre-submit CAPTCHA halt may be revalidated on a stable clean page.
 * ───────────────────────────────────────────────────────────────────────────── */

const RELOGIN = {
  // Hard ceilings. Deliberately small: recovery is a once-in-a-while repair, and a
  // login form is the last place a machine should be allowed to retry freely.
  maxAttempts: Math.min(3, Math.max(1, parseInt(pick('WHV2_RELOGIN_MAX', 'reloginMax', ''), 10) || 3)),
  // Three attempts per rolling hour; a 20-minute default gap permits 0/20/40.
  // Longer configured windows remain effective, but shorter ones cannot weaken the hourly cap.
  windowMs: Math.max(60 * 60000, parseInt(pick('WHV2_RELOGIN_WINDOW_MS', 'reloginWindowMs', ''), 10) || 60 * 60000),
  cooldownMs: Math.max(5 * 60000, parseInt(pick('WHV2_RELOGIN_COOLDOWN_MS', 'reloginCooldownMs', ''), 10) || 20 * 60000),
  // How long to wait for the app to finish signing in before calling it a failure.
  authWaitMs: Math.max(15000, parseInt(pick('WHV2_RELOGIN_WAIT_MS', 'reloginWaitMs', ''), 10) || 60000),
  // Loading/SPA hydration gets a separate bounded allowance. No extra reloads
  // or credential attempts are granted by a slow page.
  reloadWaitMs:Math.min(180000,Math.max(60000,parseInt(pick('WHV2_RELOAD_WAIT_MS','reloadWaitMs',''),10)||120000)),
  overallWaitMs:300000,
  // Form validation may enable Login asynchronously after normal input/change events.
  submitWaitMs: 8000,
  hydrationWaitMs: 2000,
  sampleMs: 250,
  // COOKIE_BUNDLE_UNCHANGED does not authenticate a recovered account. Preserve
  // the pending verdict briefly for a genuinely NEW browser cookie, then give
  // the operator a finite, truthful unconfirmed outcome (no forced re-login).
  verificationTimeoutMs: Math.min(60 * 60000, Math.max(5 * 60000,
    parseInt(pick('WHV2_VERIFY_TIMEOUT_MS', 'verificationTimeoutMs', ''), 10) || 15 * 60000)),
};
// Stop immediately on these outcomes. Only a positively recorded pre-submit
// CAPTCHA halt has a bounded passive revalidation path; no challenge is solved.
const RELOGIN_TERMINAL = ['wrong_credentials', 'mfa_required', 'captcha_required', 'rate_limited', 'account_restricted', 'wrong_account',
  'session_limit_requires_manual_reset', 'session_limit_control_unverified', 'session_limit_reset_budget_exhausted',
  'session_limit_reset_failed', 'session_limit_after_reset', 'session_limit_live_authorization_required', 'submission_outcome_unknown'];

function reloginStatePath() {
  return process.env.WHV2_RELOGIN_STATE || FILE_CFG.reloginStateFile
    || path.join(path.dirname(CFG.deviceStateFile), 'agent-relogin.json');
}

function readReloginState() {
  const file = reloginStatePath();
  let s;
  try { s = JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); }
  catch (e) {
    if (e.code !== 'ENOENT') return { attempts:[],sessionLimitResets:[],haltedReason:'state_unreadable',lastOutcome:'state_unreadable' };
    return { attempts:[],sessionLimitResets:[],haltedReason:null,haltedAt:null };
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { attempts:[],sessionLimitResets:[],haltedReason:'state_unreadable',lastOutcome:'state_unreadable' };
  // Never turn corrupt safety counters or submission state into a fresh budget.
  const invalid=()=>({attempts:[],sessionLimitResets:[],haltedReason:RELOGIN_TERMINAL.includes(s.haltedReason)?s.haltedReason:'state_unreadable',lastOutcome:'state_unreadable'});
  for(const key of ['attempts','sessionLimitResets'])if(s[key]!=null&&(!Array.isArray(s[key])||!s[key].every(Number.isFinite)))return invalid();
  if(s.captchaAutoResumes!=null&&(!Array.isArray(s.captchaAutoResumes)||!s.captchaAutoResumes.every(n=>Number.isFinite(n)&&n>=0)))return invalid();
  if(s.captchaRecheckAt!=null&&(!Number.isFinite(s.captchaRecheckAt)||s.captchaRecheckAt<0))return invalid();
  if(s.captchaHaltPreSubmit!=null&&typeof s.captchaHaltPreSubmit!=='boolean')return invalid();
  if(s.captchaHaltPreSubmit===true&&s.incident?.credentialSubmitted!==false)return invalid();
  if(s.pendingVerification!=null&&typeof s.pendingVerification!=='boolean')return invalid();
  if(s.incident!=null){
    if(typeof s.incident!=='object'||Array.isArray(s.incident)||!/^[a-f0-9-]{36}$/.test(String(s.incident.id)))return invalid();
    for(const key of ['reloaded','navigationClicked','routeNavigated','emailSubmitted','credentialSubmitted','closed'])
      if(s.incident[key]!=null&&typeof s.incident[key]!=='boolean')return invalid();
  }
  return {
    ...s,
    attempts:Array.isArray(s.attempts)?s.attempts.filter(Number.isFinite):[],
    sessionLimitResets:Array.isArray(s.sessionLimitResets)?s.sessionLimitResets.filter(Number.isFinite):[],
    haltedReason:typeof s.haltedReason==='string'?s.haltedReason:null,haltedAt:s.haltedAt||null,
    lastOutcome:typeof s.lastOutcome==='string'?s.lastOutcome:null,lastAttemptAt:s.lastAttemptAt||null,
    lastVerdictAt:s.lastVerdictAt||null,pendingVerification:s.pendingVerification===true,
    verificationStartedAt:typeof s.verificationStartedAt==='string'?s.verificationStartedAt:null,
    lastPageRecheckAt:Number.isFinite(s.lastPageRecheckAt)?s.lastPageRecheckAt:null,
    lastRotationHash:typeof s.lastRotationHash==='string'&&/^[a-f0-9]{64}$/.test(s.lastRotationHash)?s.lastRotationHash:null,
    lastRotationAttempts:Number.isInteger(s.lastRotationAttempts)&&s.lastRotationAttempts>=1?Math.min(s.lastRotationAttempts,2):1,
    lastRotationAt:typeof s.lastRotationAt==='string'?s.lastRotationAt:null,
    lastChallengeReview:s.lastChallengeReview&&safeTimestamp(s.lastChallengeReview.at)&&['captcha_required','mfa_required'].includes(s.lastChallengeReview.reason)
      ?{at:s.lastChallengeReview.at,reason:s.lastChallengeReview.reason}:null,
    incidentHistory:Array.isArray(s.incidentHistory)?s.incidentHistory.slice(-20):[],
    incident: s.incident && /^[a-f0-9-]{36}$/.test(String(s.incident.id)) ? {
      id:s.incident.id, startedAt:s.incident.startedAt, stageAt:safeTimestamp(s.incident.stageAt),stage:safeCode(s.incident.stage)||'LOGIN_REQUIRED',
      reason:safeCode(s.incident.reason)||'unknown', reloaded:s.incident.reloaded===true,
      navigationClicked:s.incident.navigationClicked===true, routeNavigated:s.incident.routeNavigated===true,
      emailSubmitted:s.incident.emailSubmitted===true, credentialSubmitted:s.incident.credentialSubmitted===true,
      closed:s.incident.closed===true,
    } : null,
  };
}

function recoveryIncident(reason) {
  const st=readReloginState();
  const previous=st.incident;
  // RC1 left retryable failures open. Only an eligible pre-submission retry may
  // replace them; persisted halts and uncertain password submissions stay locked.
  if(previous&&!previous.closed&&!(previous.stage==='FAILED'&&!previous.credentialSubmitted&&!st.haltedReason))return previous;
  const incident={id:crypto.randomUUID(),startedAt:new Date().toISOString(),stage:'LOGIN_REQUIRED',reason:safeCode(reason)||'unknown',
    reloaded:false,navigationClicked:false,routeNavigated:false,emailSubmitted:false,credentialSubmitted:false,closed:false};
  const incidentHistory=previous?[...(st.incidentHistory||[]),{id:previous.id,startedAt:safeTimestamp(previous.startedAt),
    stage:safeCode(previous.stage),outcome:safeCode(st.lastOutcome),closed:true}].slice(-20):st.incidentHistory;
  if(!writeReloginState({...st,incidentHistory,incident}))throw new Error('relogin_state_unwritable');
  return incident;
}
function recoveryTransition(stage,reason,changes={}) {
  const st=readReloginState();
  if(!st.incident)return;
  const now=Date.now(),incident={...st.incident,...changes,stage,stageAt:new Date(now).toISOString()};
  if(!writeReloginState({...st,incident}))throw new Error('relogin_state_unwritable');
  logRecoveryTransition(st,incident,stage,reason,now);
}
function logRecoveryTransition(st,incident,stage,reason,now=Date.now()) {
  const report=reloginReport();
  const event=({RELOAD_ONCE:'PAGE_RELOAD_REQUESTED',FORM_READY:'LOGIN_FORM_READY',NAVIGATION:reason==='login_control_clicked'?'LOGIN_CLICKED':'NAVIGATION',
    VERIFY_PENDING:'BACKEND_VERIFICATION_PENDING',FAILED:'RECOVERY_FAILED',MANUAL_ACTION:'MANUAL_INTERVENTION_REQUIRED'})[stage]||stage;
  log('recovery_transition',{incident_id:incident.id,stage,event,reason,
    duration_ms:Math.max(0,now-(Date.parse(incident.startedAt)||now)),stage_duration_ms:Math.max(0,now-(Date.parse(st.incident.stageAt||incident.startedAt)||now)),attempt_count:report.attemptsInWindow||0,
    next_retry_at:report.nextRetryAt,manual_required:RELOGIN_TERMINAL.includes(reason),reloaded:incident.reloaded});
}

async function waitForRecoveryPage(sess,state,predicate,timeoutMs=RELOGIN.authWaitMs,details={}) {
  const started=monoNow(),deadline=Math.min(started+timeoutMs,state.recoveryDeadline||Infinity);
  let stable=0,last={},lastIdentity=null,samples=0,transientErrors=0;
  const finish=(complete)=>{
    if(details.phase==='reload_wait'){
      const summary={at:new Date().toISOString(),phase:'reload_wait',outcome:complete?'completed':'timeout',
        elapsedMs:Math.max(0,monoNow()-started),samples,transientErrors,
        documentChanged:Number.isFinite(last.documentEpoch)&&last.documentEpoch!==details.originalEpoch,
        page:safePageSnapshot(last)};
      const saved=readReloginState();
      if(saved.lastOutcome!=='state_unreadable'&&!writeReloginState({...saved,lastPageWait:summary}))throw Error('relogin_state_unwritable');
      log('relogin_page_wait',{reason:complete?'page_wait_completed':'page_wait_timeout',state:summary.page.state,
        duration_ms:summary.elapsedMs,samples,transient_errors:transientErrors,document_changed:summary.documentChanged,page_ready:summary.page.pageReady});
    }
    return {...last,waitComplete:complete};
  };
  do {
    await recoveryPulse(state,deadline);
    if(monoNow()>=deadline)break;
    try{last=await probePage(sess,Math.min(12000,Math.max(1000,deadline-monoNow())));}catch(e){if(e.message!=='cdp_command_failed')throw e;last={};transientErrors++;}
    samples++;
    // A redirect/destroyed execution context is unknown, not a failed password.
    if(last.href && isApprovedWriteHumanUrl(last.href)) {
      const block=loginEntryBlock(last);
      if(block)throw new Error(block);
      const identity=JSON.stringify([last.href,last.documentEpoch??null,!!last.loginEvidence,!!last.loginEntryEvidence,!!last.authenticated,!!last.sessionLimit]);
      const matches=last.pageReady===true&&predicate(last);
      stable=matches?(identity===lastIdentity?stable+1:1):0;
      lastIdentity=matches?identity:null;
      if(stable>=2&&monoNow()<deadline)return finish(true);
    } else {stable=0;lastIdentity=null;}
    if(monoNow()>=deadline)break;
    await sleep(Math.min(RELOGIN.sampleMs,Math.max(0,deadline-monoNow())));
  } while(monoNow()<deadline);
  return finish(false);
}
function writeReloginState(st) {
  // An invalid read is a sentinel, never a sanitized replacement for the file.
  // All automatic writers share this guard so valid counters cannot disappear
  // when another field is corrupt. Recovery requires separate operator repair.
  if(readReloginState().lastOutcome==='state_unreadable')return false;
  const target=reloginStatePath(), temp=target+'.'+process.pid+'.tmp';
  try {
    fs.mkdirSync(path.dirname(target),{recursive:true});
    const fd=fs.openSync(temp,'w',0o600);
    try { fs.writeFileSync(fd,JSON.stringify(st,null,2));fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp,target);
    return true;
  } catch (_) {
    try {fs.unlinkSync(temp);}catch(_){}
    log('relogin_state_write_failed',{code:'state_unwritable'});
    return false;
  }
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
    let ws, opened = false, closed = false, nextId = 1;
    const pending = new Map();
    let hardStop, connectStop;
    const fail = (code) => {
      if (closed) return;
      closed = true;
      clearTimeout(hardStop); clearTimeout(connectStop);
      const error = new Error(code);
      if (!opened) reject(error); // The old implementation left this promise unresolved.
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      try { ws.close(); } catch (_) {}
    };
    try { ws = new WebSocket(wsUrl); } catch (_) { reject(new Error('cdp_ws_construct_failed')); return; }
    connectStop = setTimeout(() => fail('cdp_connect_timeout'), 8000);
    hardStop = setTimeout(() => fail('cdp_session_timeout'), Math.max(20000, totalTimeoutMs || 90000));
    ws.onerror = () => fail('cdp_ws_error');
    ws.onclose = () => fail('cdp_ws_closed');
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (_) { return; }
      const entry = pending.get(msg.id); if (!entry) return;
      pending.delete(msg.id);
      // Never propagate arbitrary browser exception text: it can contain form values.
      if (msg.error) entry.reject(new Error('cdp_command_failed'));
      else entry.resolve(msg.result || {});
    };
    ws.onopen = () => {
      if (closed) return;
      opened = true; clearTimeout(connectStop);
      resolve({
        send(method, params, timeoutMs) {
          if (closed) return Promise.reject(new Error('cdp_ws_closed'));
          const id = nextId++;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id); rej(new Error('cdp_command_timeout'));
            }, Math.max(1000, timeoutMs || 15000));
            pending.set(id, {
              resolve(v) { clearTimeout(timer); res(v); },
              reject(e) { clearTimeout(timer); rej(e); },
            });
            try { ws.send(JSON.stringify({ id, method, params: params || {} })); }
            catch (_) { pending.get(id).reject(new Error('cdp_send_failed')); pending.delete(id); }
          });
        },
        close() { fail('cdp_ws_closed'); },
      });
    };
  });
}

// Page-side probe, run as an expression (no secrets inside it). Reports what the
// login surface currently looks like so the caller can decide: fill, or halt for a
// human. Kept deliberately conservative — anything it is not sure about is 'unknown'.

const RELOGIN_PROBE = `(function(){
  if(location.origin!=='https://writehuman.ai')return JSON.stringify({approvedOrigin:false});
  function vis(el){
    if(!el || el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    var r=el.getBoundingClientRect(), style=getComputedStyle(el);
    if(!r.width || !r.height || !el.getClientRects().length || style.visibility==='hidden' || style.display==='none') return false;
    for(var n=el;n&&n.nodeType===1;n=n.parentElement){ if(getComputedStyle(n).opacity==='0') return false; }
    return true;
  }
  function enabled(el){return vis(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';}
  function selector(el){
    if(!el) return null;
    if(el.id&&document.querySelectorAll('#'+CSS.escape(el.id)).length===1) return '#'+CSS.escape(el.id);
    var parts=[];
    for(var n=el;n&&n.nodeType===1;n=n.parentElement){
      var part=n.tagName.toLowerCase(), siblings=n.parentElement?Array.from(n.parentElement.children).filter(function(x){return x.tagName===n.tagName;}):[n];
      part+=':nth-of-type('+(siblings.indexOf(n)+1)+')'; parts.unshift(part);
      if(n===document.documentElement)break;
    }
    return parts.join(' > ');
  }
  function related(el,group){return group.tagName==='FORM'?el.form===group:group.contains(el);}
  function pick(sels,group){
    if(!group)return null;
    for(var i=0;i<sels.length;i++){
      var nodes=document.querySelectorAll(sels[i]);
      for(var j=0;j<nodes.length;j++){if(enabled(nodes[j])&&related(nodes[j],group))return selector(nodes[j]);}
    }
    return null;
  }
  var emailSels=['input[type="email"]','input[name="email"]','input[autocomplete="username"]','input[name="username"]','input[id*="email" i]'];
  var passSels=['input[type="password"]:not([autocomplete="new-password"])','input[autocomplete="current-password"]'];
  var candidates=Array.from(document.querySelectorAll(passSels.join(','))).filter(enabled);
  var passwordFieldPresent=candidates.length>0;
  if(!candidates.length)candidates=Array.from(document.querySelectorAll(emailSels.join(','))).filter(enabled);
  var groups=[];
  candidates.forEach(function(el){
    var group=el.form||el.closest('[role="form"],[data-testid*="login" i],[data-testid*="signin" i]');
    if(!group){
      var n=el.parentElement;
      for(var i=0;n&&i<4;i++,n=n.parentElement){
        if(n===document.body)break;
        if(n.querySelector('button,input[type="submit"]')){group=n;break;}
      }
    }
    if(group&&vis(group)&&groups.indexOf(group)<0)groups.push(group);
  });
  var ambiguous=groups.length>1, group=groups.length===1?groups[0]:null;
  // Keep fields and submit in the SAME login form; a Search/newsletter form is unrelated.
  var email = pick(emailSels,group);
  var pass = pick(passSels,group);
  var emailEl=email?document.querySelector(email):null, passEl=pass?document.querySelector(pass):null;
  // A disabled Login button is form evidence, not permission to submit. Never enable it ourselves.
  var buttons=group?Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]')).filter(function(b){return vis(b)&&related(b,group);}):[];
  function label(b){return (b.innerText||b.value||b.textContent||b.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ');}
  var semantic=buttons.filter(function(b){return /^(log\\s*in|sign\\s*in|login|continue|next|continue with email)$/i.test(label(b));});
  var fallback=buttons.filter(function(b){return b.type==='submit'&&!/(search|subscribe|register|sign\\s*up|create|reset|google|apple|facebook)/i.test(label(b));});
  var chosen=semantic.length===1?semantic[0]:(semantic.length===0&&fallback.length===1?fallback[0]:null);
  var submitCandidate=chosen?selector(chosen):null;
  var submit=chosen&&enabled(chosen)?submitCandidate:null;
  var actionOK=true;
  if(group){
    try {
      var action=(chosen&&chosen.getAttribute('formaction'))||group.getAttribute('action');
      if(action){var actionUrl=new URL(action,document.baseURI);actionOK=actionUrl.origin==='https://writehuman.ai'&&!actionUrl.username&&!actionUrl.password;}
    }catch(_){actionOK=false;}
  }
  var text=(document.body?document.body.innerText||'':'').slice(0,8000).replace(/\\s+/g,' ');
  var localText=(group?group.innerText||'':'').slice(0,4000);
  var alerts=Array.from(document.querySelectorAll('[role="alert"],[role="dialog"],[aria-live="assertive"]')).filter(vis).map(function(n){return n.innerText||'';}).join(' ').slice(0,4000);
  var authPath=/(?:^|\\/)(?:login|sign-in|signin)(?:\\/|$)/i.test(location.pathname)||(location.pathname.replace(/\\/$/,'')==='/signup'&&new URLSearchParams(location.search).get('mode')==='login');
  var feedback=(localText+' '+alerts+(authPath?' '+text:''));
  // Providers commonly inject passive/off-screen CAPTCHA infrastructure even when
  // nobody is being asked to solve a challenge. A mere iframe or data-sitekey is
  // NOT proof of a human gate. Stop only for a VISIBLE interactive challenge.
  function inViewport(n){
    if(!vis(n))return false;
    var r=n.getBoundingClientRect();
    return r.right>0&&r.bottom>0&&r.left<(window.innerWidth||document.documentElement.clientWidth)&&
      r.top<(window.innerHeight||document.documentElement.clientHeight);
  }
  function interactiveCaptcha(n){
    if(!inViewport(n)||n.closest('.grecaptcha-badge,[data-size="invisible"],[data-recaptcha-size="invisible"]'))return false;
    var r=n.getBoundingClientRect();
    // A visible embedded CAPTCHA checkbox/verification frame is a real user gate.
    if(n.tagName==='IFRAME')return r.width>=80&&r.height>=35;
    // A provider may mark the entire form with data-sitekey: do not treat the
    // ordinary Email/Password/Log In form as a CAPTCHA challenge.
    var caption=String(n.innerText||'').slice(0,750);
    if(/(?:verify(?:\\s+that)?\\s+(?:you\\s+are\\s+)?human|i[’']?m\\s+not\\s+a\\s+robot|captcha|complete\\s+the\\s+security\\s+check)/i.test(caption))return true;
    return Array.from(n.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"]')).some(function(f){
      return inViewport(f)&&f.getBoundingClientRect().width>=80&&f.getBoundingClientRect().height>=35;
    });
  }
  var captcha=Array.from(document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]')).some(interactiveCaptcha);
  if(!captcha)captcha=Array.from(document.querySelectorAll('[role="dialog"],[role="alert"]')).some(function(n){
    return inViewport(n)&&/(?:verify\\s+you\\s+are\\s+human|i[’']?m\\s+not\\s+a\\s+robot|captcha\\s+required)/i.test(String(n.innerText||'').slice(0,750));
  });
  var otp=Array.from(document.querySelectorAll('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="code" i][maxlength]')).some(enabled);
  var mfaText=/two[- ]factor|verification code|authenticator|enter the code|\\b2fa\\b/i.test(feedback);
  var limitMessage=/(?:\\b(?:3|three)[ ]+(?:active[ ]+)?(?:sessions?|devices?)[^.!?]{0,90}(?:already|logged[ ]+in|maximum|limit)|(?:too[ ]+many|maximum(?:[ ]+number[ ]+of)?|limit[ ]+of)[ ]+(?:active[ ]+)?(?:sessions?|devices?)|(?:sessions?|devices?)[ ]+limit[ ]+(?:reached|exceeded)|(?:logged[ ]+in|signed[ ]+in)[ ]+on[ ]+too[ ]+many[ ]+devices)/i.test(text);
  var signOutAllCount=Array.from(document.querySelectorAll('button,[role="button"],a')).filter(function(b){return enabled(b)&&/^(?:sign out all|sign out all sessions|sign out all other sessions)$/i.test(label(b));}).length;
  var badCreds=/invalid login credentials|incorrect (email|password)|wrong password|credentials are invalid|email or password is incorrect/i.test(feedback);
  var rate=/too many (requests|attempts)|rate limit|try again later/i.test(feedback);
  var locked=/account (is )?(locked|suspended|disabled)|has been suspended/i.test(feedback);
  var controls=Array.from(document.querySelectorAll('a,button,[role="button"]')).filter(vis);
  var signedIn=controls.some(function(n){return /^(sign out|log out|my account)$/i.test(label(n))||(n.tagName==='A'&&/^\\/(myaccount|my-account|account)(?:[/?#]|$)/i.test(n.getAttribute('href')||''));});
  var loginEvidence=!ambiguous&&!!group&&!!(email||pass)&&!!submitCandidate&&actionOK&&(authPath||!!semantic.length)&&(!signedIn||limitMessage);
  // Navigation evidence is NOT authentication/expiry proof. Only a visible,
  // same-origin, normal Login link in the header/navigation (or a paired
  // Login + Sign Up container) may lead to the existing login flow. Ignore
  // footer marketing links, foreign targets, ambiguous entries and dirty editors.
  var pageReady=document.readyState==='complete';
  // The provider can render an avatar-only account menu. Preserve token rotation
  // on its EMPTY working editor, without mistaking an unknown/error page for a
  // safely reloadable signed-in page. Only the BOOLEAN is returned, never text.
  var editorPresent=Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')).some(vis);
  var editorBusy=Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],input[type="text"],input[type="search"],input[type="email"]')).some(function(n){
    if(!vis(n)||(loginEvidence&&group&&related(n,group)))return false;
    return n===document.activeElement||n.contains(document.activeElement)||!!String(n.value||n.textContent||'').trim();
  });
  function approvedEntryLink(n){
    if(!enabled(n)||n.closest('form,footer,[role="contentinfo"]')||n.form)return false;
    if(!/^(log\\s*in|sign\\s*in|login)$/i.test(label(n)))return false;
    // A semantic header button is navigation evidence only. Use the approved
    // configured login route; do not execute arbitrary onclick/javascript URLs.
    if(n.tagName==='BUTTON'||(n.tagName!=='A'&&n.getAttribute('role')==='button'))return true;
    if(n.tagName!=='A')return false;
    try {
      var u=new URL(n.getAttribute('href')||'',document.baseURI);
      return u.origin==='https://writehuman.ai'&&!u.username&&!u.password&&
        (/^\\/(login|signin|sign-in)\\/?$/i.test(u.pathname)||(u.pathname.replace(/\\/$/,'')==='/signup'&&u.searchParams.get('mode')==='login'));
    }catch(_){return false;}
  }
  function entryContainer(n){
    if(n.closest('header,nav,[role="navigation"]'))return true;
    for(var a=n.parentElement,i=0;a&&a!==document.body&&i<4;a=a.parentElement,i++){
      if(/^(FORM|FOOTER|ARTICLE|MAIN)$/.test(a.tagName))return false;
      var pair=Array.from(a.querySelectorAll('a,button,[role="button"]')).some(function(b){
        return enabled(b)&&/^(sign\\s*up|register)$/i.test(label(b));
      });
      if(pair)return true;
    }
    return false;
  }
  var entryLinks=Array.from(document.querySelectorAll('a[href],button,[role="button"]')).filter(function(n){return approvedEntryLink(n)&&entryContainer(n);});
  var loginEntryEvidence=pageReady&&!authPath&&!loginEvidence&&!passwordFieldPresent&&!signedIn&&!editorBusy&&!captcha&&!otp&&!mfaText&&!rate&&!locked&&entryLinks.length===1;
  return JSON.stringify({href:location.href,path:location.pathname,documentEpoch:performance.timeOrigin,email:email,pass:pass,submit:submit,submitCandidate:submitCandidate,submitReady:!!submit,step:!pass?submit:null,
    pageReady:pageReady,readyState:document.readyState,editorBusy:editorBusy,editorPresent:editorPresent,loginEntryEvidence:loginEntryEvidence,loginEntry:loginEntryEvidence?selector(entryLinks[0]):null,
    emailFilled:!!(emailEl&&emailEl.value),passwordFilled:!!(passEl&&passEl.value),form:selector(group),
    formActionApproved:actionOK,ambiguous:ambiguous,loginEvidence:loginEvidence,
    authenticated:signedIn&&!limitMessage&&!email&&!pass,captcha:captcha,otp:otp,mfaText:mfaText,badCreds:badCreds,rate:rate,locked:locked,
    sessionLimit:!!limitMessage,signOutAllCount:signOutAllCount});
})()`;

async function probePage(sess,timeoutMs=12000) {
  const r = await sess.send('Runtime.evaluate', { expression: RELOGIN_PROBE, returnByValue: true }, timeoutMs);
  try { return JSON.parse((r.result && r.result.value) || '{}'); } catch (_) { return {}; }
}

// Fixed enums and booleans only. Never export URLs, selectors, page text,
// account identifiers, credential values, cookies or CDP addresses.
function safePageSnapshot(p={}){
  const approved=isApprovedWriteHumanUrl(p.href);
  const out={approvedOrigin:approved,pageReady:approved&&p.pageReady===true,
    readyState:approved&&['loading','interactive','complete'].includes(p.readyState)?p.readyState:'unknown'};
  for(const key of ['editorBusy','editorPresent','loginEvidence','loginEntryEvidence','authenticated','emailFilled','passwordFilled','captcha','otp','mfaText','badCreds','rate','locked','sessionLimit','ambiguous'])out[key]=approved&&p[key]===true;
  out.emailPresent=approved&&!!p.email;out.passwordPresent=approved&&!!p.pass;out.submitReady=approved&&!!p.submit;
  out.state=!approved?'unavailable':out.captcha?'captcha_required':out.otp||out.mfaText?'mfa_required':out.badCreds?'wrong_credentials':
    out.rate?'rate_limited':out.locked?'account_restricted':!out.pageReady?'loading':out.sessionLimit?'session_limit':
    out.ambiguous?'ambiguous_login_form':out.loginEvidence?'login_required':out.loginEntryEvidence?'login_entry':out.authenticated?'authenticated':out.editorBusy?'editor_busy':'unknown';
  return out;
}

async function recoveryDiagnostics(){
  const result={observedAt:new Date().toISOString(),retry:reloginReport(),
    browser:{state:'unavailable',stable:false,cookieReadPerformed:false,reason:null},lastPageWait:null};
  const saved=readReloginState(),w=saved.lastPageWait;
  if(w&&safeTimestamp(w.at)&&w.phase==='reload_wait'&&['completed','timeout'].includes(w.outcome)){
    const page=w.page||{};
    result.lastPageWait={at:w.at,phase:'reload_wait',outcome:w.outcome,
      elapsedMs:Number.isFinite(w.elapsedMs)?w.elapsedMs:null,samples:Number.isFinite(w.samples)?w.samples:null,
      transientErrors:Number.isFinite(w.transientErrors)?w.transientErrors:null,documentChanged:w.documentChanged===true,
      page:{state:safeCode(page.state)||'unknown',pageReady:page.pageReady===true,
        readyState:['loading','interactive','complete'].includes(page.readyState)?page.readyState:'unknown'}};
  }
  let sess;
  try{
    if(!CFG.chromeProfile)throw Error('no_profile_proof');
    const connection={};await getAllCookiesViaCDP(CFG.cdpUrl,connection,true);
    if(connection.profile!=='configured-profile-verified')throw Error('no_profile_proof');
    const targets=async()=>{
      const r=await fetch(CFG.cdpUrl+'/json/list',{signal:AbortSignal.timeout(6000)});
      if(!r.ok)throw Error('cdp_unreachable');
      const all=await r.json();
      return (Array.isArray(all)?all:[]).filter(p=>p?.type==='page'&&isApprovedWriteHumanUrl(p.url));
    };
    const all=await targets();
    if(all.length!==1)throw Error(all.length?'multiple_approved_tabs':'no_tab');
    const page=all[0];if(!isApprovedCdpPageSocket(page.webSocketDebuggerUrl))throw Error('untrusted_cdp_page');
    sess=await cdpSession(page.webSocketDebuggerUrl,20000);
    const first=await probePage(sess);await sleep(250);
    const current=await targets();
    if(current.length!==1||current[0].webSocketDebuggerUrl!==page.webSocketDebuggerUrl)throw Error('source_page_changed');
    const second=await probePage(sess),a=safePageSnapshot(first),b=safePageSnapshot(second);
    const stable=b.approvedOrigin&&first.href===second.href&&Number.isFinite(first.documentEpoch)&&first.documentEpoch===second.documentEpoch&&JSON.stringify(a)===JSON.stringify(b);
    result.browser={...b,stable,cookieReadPerformed:false,reason:stable?null:'deferred_page_changed'};
  }catch(e){result.browser.reason=safeCode(e?.message)||'deferred_inspection_failed';}
  finally{if(sess)sess.close();}
  result.retry=reloginReport();
  result.observedAt=new Date().toISOString();
  return result;
}

// HIGH-IMPACT ACCOUNT ACTION. Clicking this official provider control logs out
// ALL sessions of this account (not just the RDP). A separate explicit setting is
// required, and the action is budgeted to ONCE per 24 hours across Agent restarts.
// We NEVER guess at a selector; it must be exactly one visible, enabled control
// whose text is exactly one approved global Sign out all label on the real origin
// AND alongside an actual session-limit warning. Fail closed on any uncertainty.
const SIGNOUT_ALL_CONFIRMED_EXPRESSION = `(function(){
  if (location.origin !== 'https://writehuman.ai') return false;
  var text=(document.body ? (document.body.innerText||'') : '').slice(0,8000).replace(/\\s+/g,' ');
  if (!/(?:\\b(?:3|three)[ ]+(?:active[ ]+)?(?:sessions?|devices?)[^.!?]{0,90}(?:already|logged[ ]+in|maximum|limit)|(?:too[ ]+many|maximum(?:[ ]+number[ ]+of)?|limit[ ]+of)[ ]+(?:active[ ]+)?(?:sessions?|devices?)|(?:sessions?|devices?)[ ]+limit[ ]+(?:reached|exceeded)|(?:logged[ ]+in|signed[ ]+in)[ ]+on[ ]+too[ ]+many[ ]+devices)/i.test(text)) return false;
  var controls=Array.from(document.querySelectorAll('button,[role="button"],a')).filter(function(el){
    var t=(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ');
    var r=el.getBoundingClientRect();
    return r.width>0 && r.height>0 && getComputedStyle(el).visibility!=='hidden' &&
      !el.disabled && /^(?:sign out all|sign out all sessions|sign out all other sessions)$/i.test(t);
  });
  if (controls.length!==1) return false;
  var b=controls[0];
  if (b.tagName==='A' && b.href && !b.href.startsWith('https://writehuman.ai/')) return false;
  b.click(); return true;
})()`;

async function resetSessionLimitOnce(sess) {
  if (!CFG.sessionLimitSignOutAll) return 'session_limit_requires_manual_reset';
  const authorizedUntil=Date.parse(CFG.sessionLimitLiveAuthorizationUntil||'');
  if(CFG.sessionLimitConsent!=='official-provider-session-limit-v1'&&(!Number.isFinite(authorizedUntil)||authorizedUntil<=Date.now()||authorizedUntil-Date.now()>24*3600000))
    return 'session_limit_live_authorization_required';
  const p = await probePage(sess).catch(() => ({}));
  if (!p.href || !isApprovedWriteHumanUrl(p.href)) return 'unapproved_login_origin';
  if (p.captcha) return 'captcha_required';
  if (p.otp || p.mfaText) return 'mfa_required';
  if (p.rate) return 'rate_limited';
  if (p.locked) return 'account_restricted';
  if (!p.sessionLimit || p.signOutAllCount !== 1) return 'session_limit_control_unverified';
  const st = readReloginState();
  const now = Date.now();
  const resets = (st.sessionLimitResets || []).filter(t => now - t < 24 * 3600000);
  if (resets.length >= 1) return 'session_limit_reset_budget_exhausted';
  // Persist BEFORE performing the account-wide logout; a process crash cannot
  // silently reset the budget and sign out everyone's sessions repeatedly.
  if (!writeReloginState(Object.assign({}, st, {sessionLimitResets: resets.concat(now)}))) return 'session_limit_reset_failed';
  const clicked = await sess.send('Runtime.evaluate', {
    expression: SIGNOUT_ALL_CONFIRMED_EXPRESSION, returnByValue: true,
  }, 10000).catch(() => null);
  if (!clicked || !clicked.result || clicked.result.value !== true) return 'session_limit_reset_failed';
  log('relogin_session_limit_signout_all', {global: true, count_24h: resets.length + 1});
  return 'clicked';
}

// Resolve the field in the approved document, then pass its value as a CDP
// function argument. Navigation invalidates the object rather than redirecting input.

async function typeInto(sess, selector, text) {
  const r = await sess.send('Runtime.evaluate', {
    expression: '(function(){if(location.origin!=="https://writehuman.ai")return null;' +
      'var n=document.querySelector(' + JSON.stringify(selector) + ');' +
      'if(!n||n.disabled||n.readOnly||!n.getClientRects().length)return null;return n;})()',
    objectGroup: 'wh-source-login', returnByValue: false,
  }, 8000);
  if (r.exceptionDetails || !r.result || !r.result.objectId) throw new Error('field_not_found_or_bad_origin');
  // A stale objectId dies on navigation. The origin check and native setter execute in
  // that same document; unlike Input.insertText, they cannot type into a new foreign page.
  const out = await sess.send('Runtime.callFunctionOn', {
    objectId: r.result.objectId,
    functionDeclaration: 'function(value){' +
      'if(location.origin!=="https://writehuman.ai"||this.ownerDocument!==document||!this.isConnected||this.disabled||this.readOnly)return false;' +
      'var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;' +
      'this.focus();setter.call(this,value);this.dispatchEvent(new Event("input",{bubbles:true}));' +
      'this.dispatchEvent(new Event("change",{bubbles:true}));return true;}',
    arguments: [{ value: text }], returnByValue: true,
  }, 8000);
  if (out.exceptionDetails || !out.result || out.result.value !== true) throw new Error('field_set_failed');
}

function recoveryBlock(probe) {
  if (!probe.href || !isApprovedWriteHumanUrl(probe.href)) return 'unapproved_login_origin';
  if (probe.captcha) return 'captcha_required';
  if (probe.otp || probe.mfaText) return 'mfa_required';
  if (probe.locked) return 'account_restricted';
  if (probe.rate) return 'rate_limited';
  if (probe.badCreds) return 'wrong_credentials';
  if (probe.ambiguous) return 'ambiguous_login_form';
  if (probe.formActionApproved === false) return 'unapproved_form_action';
  return null;
}

// A header navigation never reads/fills an unrelated newsletter or search form.
// Such a form's action/ambiguity can block credential input, but not this approved
// same-origin hop. All origin/challenge/account gates still apply; full strict
// recoveryBlock runs again on the actual login form before touching credentials.
function loginEntryBlock(probe) {
  const code = recoveryBlock(probe);
  if (probe.loginEntryEvidence === true && probe.loginEvidence !== true &&
      (code === 'ambiguous_login_form' || code === 'unapproved_form_action')) return null;
  return code;
}

async function clickLoginEntry(sess,probe,state) {
  await recoveryPulse(state);
  const current=await probePage(sess);
  if(loginEntryBlock(current)||!current.loginEntryEvidence||current.loginEntry!==probe.loginEntry||current.editorBusy)
    throw new Error('login_entry_changed');
  recoveryTransition('LOGIN_CONTROL_FOUND','login_control_clicked',{navigationClicked:true});
  const result=await sess.send('Runtime.evaluate',{
    expression:'(function(){if(location.origin!=="https://writehuman.ai")return false;'+
      'var b=document.querySelector('+JSON.stringify(current.loginEntry)+');'+
      'if(!b||b.disabled||b.getAttribute("aria-disabled")==="true"||!b.getClientRects().length||b.closest("[hidden],[inert],[aria-hidden=true]"))return false;'+
      'if(b.tagName==="A"){var u=new URL(b.href,document.baseURI);if(u.origin!==location.origin||u.username||u.password||(b.target&&b.target!=="_self"))return false;}'+
      'b.click();return true;})()',returnByValue:true,userGesture:true,
  },8000);
  if(result.exceptionDetails||result.result?.value!==true)throw new Error('login_entry_changed');
  recoveryTransition('NAVIGATION','login_control_clicked');
}

async function submitLoginForm(sess, probe, state, reservePassword=false) {
  // Wait for the provider's own validation. A visible disabled Login control can
  // identify a form, but must never be enabled/removed/force-submitted by the Agent.
  // Re-probe each time: a navigation, challenge, or replaced form invalidates it.
  const deadline = monoNow() + RELOGIN.submitWaitMs;
  let current;
  while (true) {
    if (state) await recoveryPulse(state,deadline);
    current = await probePage(sess);
    const blocked = recoveryBlock(current);
    if (blocked) throw new Error(blocked);
    if (current.loginEvidence !== true || current.form !== probe.form || (!current.submit && !current.submitCandidate)) {
      throw new Error('login_form_changed');
    }
    if (current.submit&&current.pageReady===true) break;
    if (monoNow() >= deadline) throw new Error(current.pageReady===true?'submit_still_disabled':'page_wait_timeout');
    await sleep(250);
    if (state) await recoveryPulse(state,deadline);
  }
  // Reserve immediately before the click, after readiness checks. A disabled
  // button is retryable; a dispatched click with a lost response is uncertain.
  if(reservePassword){
    if(state?.recoveryDeadline&&state.recoveryDeadline-monoNow()<Math.min(RELOGIN.authWaitMs,60000)+1000)throw Error('recovery_deadline_exceeded');
    if(readReloginState().incident?.credentialSubmitted)throw new Error('submission_outcome_unknown');
    recoveryTransition('LOGIN_SUBMITTED','existing_form',{credentialSubmitted:true});
    if(!writeReloginState({...readReloginState(),pendingVerification:true,verificationStartedAt:new Date().toISOString()}))throw new Error('relogin_state_unwritable');
    state.reloginPending=true;
  }
  const result = await sess.send('Runtime.evaluate', {
    expression: '(function(){if(location.origin!=="https://writehuman.ai")return false;' +
      'var b=document.querySelector(' + JSON.stringify(current.submit) + ');' +
      'var f=document.querySelector(' + JSON.stringify(current.form) + ');' +
      'if(!b||!f||b.disabled||b.getAttribute("aria-disabled")==="true"||!b.getClientRects().length)return false;' +
      'if(f.tagName==="FORM"?b.form!==f:!f.contains(b))return false;' +
      'var a=b.getAttribute("formaction")||f.getAttribute("action");' +
      'if(a&&new URL(a,document.baseURI).origin!=="https://writehuman.ai")return false;' +
      'b.click();return true;})()', returnByValue: true, userGesture: true,
  }, 8000);
  if (result.exceptionDetails || !result.result || result.result.value !== true) throw new Error('submit_not_found');
}

async function heartbeatIfDue(state, hash) {
  if (state.standDown || state.standDownCode || (state.activation && state.activation.running) || !heartbeatDue(state)) return;
  state.lastHeartbeatAt = monoNow();
  const r = await postToServer(state, { heartbeat: true, hash: hash ? String(hash).slice(0, 8) : null });
  if (r && r._err) log('heartbeat_failed', { code: 'transport_error' });
  else if (r && r._status) log('heartbeat_rejected', { status: r._status });
  else log('heartbeat', { recovery: !!state.reloginInFlight });
}

async function recoveryPulse(state,phaseDeadline=Infinity) {
  if(state.recoveryDeadline&&monoNow()>=state.recoveryDeadline)throw Error('recovery_deadline_exceeded');
  // A long recovery must not look like a dead singleton to another launcher.
  try { const held = readJsonFile(CFG.lockFile); if (held && held.pid === process.pid) refreshLock(); } catch (_) {}
  // A heartbeat can take up to 20 seconds. Leave that allowance inside the
  // overall observation deadline; the regular poll resumes heartbeat afterward.
  if(Math.min(state.recoveryDeadline||Infinity,phaseDeadline)-monoNow()>21000)await heartbeatIfDue(state, state.lastHash);
  if(state.recoveryDeadline&&monoNow()>=state.recoveryDeadline)throw Error('recovery_deadline_exceeded');
  if (state.standDown || state.standDownCode || state.isActiveSource !== true) throw new Error('source_not_authorized');
  if (state.activation && state.activation.running) throw new Error('activation_in_progress');
}

// Resolve an idle unknown page without inventing a logout or a new refresh-token
// exchange. Persist the rate limit before the normal page reload. User content,
// form/challenge state, active recovery, another source and saved halts block it.
async function recheckUnknownSourcePage(state, sess, probe, beforeReload) {
  if (!state.logoutEvidence && !(state.emptyPolls>=CFG.logoutDebounce)) return false;
  const saved=readReloginState();
  if(saved.haltedReason||saved.pendingVerification||saved.incident?.credentialSubmitted)return false;
  const safe=p=>isApprovedWriteHumanUrl(p.href)&&p.pageReady===true&&!p.editorBusy&&!p.authenticated&&!p.email&&!p.pass&&!p.loginEntryEvidence&&!p.sessionLimit&&!recoveryBlock(p);
  if(!safe(probe))return false;
  const incident=recoveryIncident(state.logoutEvidence||'auth_cookie_absent');
  if(incident.reloaded)return false;
  recoveryTransition('PAGE_RECHECK',state.logoutEvidence||'auth_cookie_absent');
  const current=await waitForRecoveryPage(sess,state,p=>p.loginEvidence||p.loginEntryEvidence||p.authenticated||p.editorBusy||p.sessionLimit,RELOGIN.hydrationWaitMs);
  if(!safe(current))return false;
  recoveryTransition('LOGIN_UI_MISSING',state.logoutEvidence||'auth_cookie_absent');
  await recoveryPulse(state);
  const before=await probePage(sess);
  if(!safe(before)||!Number.isFinite(before.documentEpoch))return false;
  // Persist before the side effect: restart/timeout cannot grant a second reload.
  if(beforeReload)beforeReload();
  recoveryTransition('RELOAD_ONCE','reload_requested',{reloaded:true});
  await sess.send('Page.reload',{ignoreCache:false},10000);
  const ready=await waitForRecoveryPage(sess,state,p=>Number.isFinite(p.documentEpoch)&&p.documentEpoch!==before.documentEpoch,
    RELOGIN.reloadWaitMs,{phase:'reload_wait',originalEpoch:before.documentEpoch});
  if(!ready.waitComplete)throw new Error('page_reload_timeout');
  recoveryTransition('PAGE_RELOAD_COMPLETED','reloaded');
  state.visibleLogoutCount=0;state.loginEntryCount=0;
  return true;
}

async function inspectSourceLoginPage(state) {
  if (!CFG.reloginEnabled || state.isActiveSource !== true || state.standDown || state.standDownCode || state.reloginInFlight) return null;
  const now = monoNow();
  if (state.lastPageCheckAt != null && now - state.lastPageCheckAt < CFG.reloginPageCheckMs) return null;
  state.lastPageCheckAt = now;
  let sess;
  try {
    const r = await fetch(CFG.cdpUrl + '/json/list', { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const page = findApprovedWriteHumanTab(await r.json());
    if (!page || !isApprovedCdpPageSocket(page.webSocketDebuggerUrl)) { state.visibleLogoutCount = 0; state.loginEntryCount = 0; state.unknownPageSince = null; return null; }
    sess = await cdpSession(page.webSocketDebuggerUrl, 20000);
    const p = await probePage(sess);
    if (!isApprovedWriteHumanUrl(p.href)) { state.visibleLogoutCount = 0; state.loginEntryCount = 0; state.unknownPageSince = null; return null; }
    const visibleLogout = p.loginEvidence === true || (p.sessionLimit === true && p.signOutAllCount > 0);
    const loginEntry = !visibleLogout && p.loginEntryEvidence === true && !loginEntryBlock(p);
    if (state.lastObservedPage !== page.webSocketDebuggerUrl) { state.visibleLogoutCount = 0; state.loginEntryCount = 0; state.unknownPageSince = null; }
    state.lastObservedPage = page.webSocketDebuggerUrl;
    state.visibleLogoutCount = visibleLogout ? (state.visibleLogoutCount || 0) + 1 : 0;
    state.loginEntryCount = loginEntry ? (state.loginEntryCount || 0) + 1 : 0;
    const kind = visibleLogout ? 'login_required' : (loginEntry ? 'login_entry' : (p.authenticated ? 'authenticated' : (p.editorBusy ? 'editor_busy' : 'unknown')));
    if (state.lastBrowserState !== kind || visibleLogout || loginEntry) log('relogin_page_state', { state:kind, observations:visibleLogout?state.visibleLogoutCount:state.loginEntryCount });
    state.lastBrowserState = kind;
    if(visibleLogout||loginEntry)state.browserLogoutObserved=true;
    else if(p.authenticated===true)state.browserLogoutObserved=false;
    let rechecked = false;
    // Unknown alone does not establish expiry or authorize a destructive reload.
    state.unknownPageSince = null;
    return { probe:p, visibleLogout, confirmed:visibleLogout && state.visibleLogoutCount >= CFG.logoutDebounce,
      loginEntry, entryConfirmed:loginEntry && state.loginEntryCount >= Math.max(2,CFG.logoutDebounce), rechecked };
  } catch (_) {
    state.visibleLogoutCount = 0; state.loginEntryCount = 0; state.unknownPageSince = null;
    state.lastBrowserState = 'unavailable';
    return null;
  } finally { if (sess) sess.close(); }
}

// Passive revalidation only: no navigation, reload, cookies, vault or input.
// Legacy states cannot prove whether a password was submitted, so they retain
// the explicit operator-review path even when today's page looks clean.
async function recheckStaleCaptchaHalt(state) {
  const interval=5*60000,window=86400000,now=Date.now();
  const authorized=()=>CFG.reloginEnabled&&process.platform==='win32'&&state.isActiveSource===true&&
    !state.standDown&&!state.standDownCode&&!state.reloginPending&&!state.recoveryVerdictToPersist&&!state.activation?.running;
  if(!authorized()||state.reloginInFlight||!CFG.chromeProfile)return false;
  const st=readReloginState(),halt=Date.parse(st.haltedAt||'');
  if(st.lastOutcome==='state_unreadable'||st.haltedReason!=='captcha_required'||st.captchaHaltPreSubmit!==true||
      !st.incident||st.incident.credentialSubmitted!==false||st.incident.closed||st.incident.stage!=='MANUAL_ACTION'||st.pendingVerification||
      !Number.isFinite(halt)||now-halt<interval||
      (st.captchaRecheckAt!=null&&now-st.captchaRecheckAt<interval)||
      (st.captchaAutoResumes||[]).some(n=>now-n<window))return false;
  state.reloginInFlight=true;
  let sess;
  try {
    // Reserve before asynchronous work; restart cannot reset passive scan limits.
    if(!writeReloginState({...st,captchaRecheckAt:now}))return false;
    const reserved=JSON.stringify(readReloginState());
    await getAllCookiesViaCDP(CFG.cdpUrl,null,true);
    const target=async()=>{
      const r=await fetch(CFG.cdpUrl+'/json/list',{signal:AbortSignal.timeout(6000)});
      if(!r.ok)return null;
      const pages=await r.json();
      if(!Array.isArray(pages))return null;
      const approved=pages.filter(p=>p.type==='page'&&isApprovedWriteHumanUrl(p.url));
      return approved.length===1&&isApprovedCdpPageSocket(approved[0].webSocketDebuggerUrl)?approved[0]:null;
    };
    const page=await target();if(!page||!authorized())return false;
    sess=await cdpSession(page.webSocketDebuggerUrl,12000);
    const clean=p=>p.pageReady===true&&!p.editorBusy&&!p.sessionLimit&&!recoveryBlock(p)&&
      (p.loginEvidence===true||p.loginEntryEvidence===true||p.authenticated===true);
    const first=await probePage(sess);if(!clean(first))return false;
    await sleep(2000);
    const second=await probePage(sess),again=await target();
    if(!clean(second)||first.href!==second.href||first.documentEpoch!==second.documentEpoch||first.loginEvidence!==second.loginEvidence||
        first.loginEntryEvidence!==second.loginEntryEvidence||first.authenticated!==second.authenticated||
        !again||again.webSocketDebuggerUrl!==page.webSocketDebuggerUrl||!authorized())return false;
    const current=readReloginState();if(JSON.stringify(current)!==reserved)return false;
    const at=Date.now();
    if(at<now)return false; // clock moved backwards while observing
    const next={...current,haltedReason:null,haltedAt:null,captchaHaltPreSubmit:false,
      lastOutcome:'captcha_halt_revalidated',lastBlock:null,
      captchaAutoResumes:[at],lastCaptchaReview:{at:new Date(at).toISOString(),reason:'captcha_required',haltedAt:current.haltedAt,incidentId:current.incident.id},
      incident:{...current.incident,closed:true}};
    if(!writeReloginState(next))return false;
    log('captcha_halt_revalidated',{reason:'captcha_halt_revalidated',incident_id:current.incident.id,count_24h:1});
    return true;
  } catch (_) {
    log('captcha_recheck_deferred',{reason:'deferred_inspection_failed'});
    return false;
  } finally { if(sess)sess.close();state.reloginInFlight=false; }
}

/**
 * One controlled recovery attempt. A changed browser session is only pending
 * verification. An active-source PROMOTED verdict confirms it later. Terminal
 * outcomes halt recovery until an operator reviews the cause; heartbeat continues.
 */

async function attemptSourceRelogin(state, reason) {
  const blocked = (reason) => {
    if (state.lastRecoveryBlock !== reason) {
      state.lastRecoveryBlock = reason;
      log('relogin_blocked', { reason });
      const saved=readReloginState();
      if(saved.lastOutcome!=='state_unreadable')writeReloginState({...saved,lastBlock:{reason:safeCode(reason),at:new Date().toISOString()}});
      log('recovery_transition',{stage:'RECOVERY_BLOCKED',event:saved.haltedReason?'MANUAL_INTERVENTION_REQUIRED':'RECOVERY_BLOCKED',reason,
        incident_id:saved.incident?.id,manual_required:!!saved.haltedReason,next_retry_at:reloginReport().nextRetryAt});
    }
    return reason;
  };
  if (!CFG.reloginEnabled) return blocked('disabled');
  if (process.platform !== 'win32') return blocked('unsupported_platform');
  if (state.reloginInFlight) return blocked('already_running');
  if (state.recoveryVerdictToPersist) return blocked('relogin_state_unwritable');
  if (state.standDown || state.standDownCode) return blocked('stood_down');
  if (state.isActiveSource !== true) return blocked('not_active_source');
  let st = readReloginState();
  if(st.haltedReason==='captcha_required'){
    await recheckStaleCaptchaHalt(state);
    st=readReloginState();
  }
  if (st.haltedReason) return blocked('halted_' + st.haltedReason);
  if(state.standDown||state.standDownCode||state.isActiveSource!==true||state.activation?.running)return blocked('source_not_authorized');
  if(state.reloginPending||st.pendingVerification)return blocked('verification_pending');
  if(st.incident?.credentialSubmitted&&!st.incident.closed)return blocked('submission_outcome_unknown');
  const now = Date.now();
  const recent = (st.attempts || []).filter(t => now - t < RELOGIN.windowMs);
  if (recent.length >= RELOGIN.maxAttempts) return blocked('budget_exhausted');
  const lastAt = recent.length ? Math.max(...recent) : 0;
  if (lastAt && now - lastAt < RELOGIN.cooldownMs) return blocked('cooldown');
  state.lastRecoveryBlock = null;

  state.reloginInFlight = true;
  state.recoveryDeadline=monoNow()+RELOGIN.overallWaitMs;
  let sess = null, credential = null, attemptRecorded = false;
  const finish = (outcome) => {
    const cur = readReloginState(), terminal = RELOGIN_TERMINAL.includes(outcome);
    const pending=outcome==='browser_authenticated_pending_verification';
    writeReloginState(Object.assign({}, cur, {
      lastOutcome: outcome, haltedReason: terminal ? outcome : cur.haltedReason,
      haltedAt: terminal ? new Date().toISOString() : cur.haltedAt,
      captchaHaltPreSubmit:terminal&&outcome==='captcha_required'&&cur.incident?.credentialSubmitted===false,
      pendingVerification: outcome === 'browser_authenticated_pending_verification',
      verificationStartedAt: outcome === 'browser_authenticated_pending_verification' ? new Date().toISOString() : null,
      ...(cur.incident?{incident:{...cur.incident,closed:!terminal&&!pending&&!cur.incident.credentialSubmitted}}:{}),
    }));
    state.reloginPending=outcome==='browser_authenticated_pending_verification';
    try { recoveryTransition(terminal?'MANUAL_ACTION':state.reloginPending?'BROWSER_CANDIDATE':outcome==='already_authenticated'?'MONITORING':'FAILED',outcome); } catch (_) {}
    if(state.reloginPending){
      if(state.providerUiAuthenticated===true)recoveryTransition('PROVIDER_AUTHENTICATED','browser_authenticated_pending_verification');
      recoveryTransition('VERIFY_PENDING','verification_pending');
    }
    log(terminal ? 'relogin_halted' : 'relogin_result', { outcome });
    return outcome;
  };
  const recordAttempt = () => {
    if (attemptRecorded) return;
    const record = Object.assign({}, readReloginState(), {
      attempts: recent.concat(Date.now()), lastAttemptAt: new Date().toISOString(), lastOutcome: 'started',
    });
    if (!writeReloginState(record)) throw new Error('relogin_state_unwritable');
    attemptRecorded = true;
    log('relogin_start', { reason, attempt: recent.length + 1, of: RELOGIN.maxAttempts });
  };
  const fillIfEmpty = async (probe, field) => {
    if (probe.loginEvidence !== true) throw new Error('login_form_not_found');
    const filled = field === 'email' ? probe.emailFilled : probe.passwordFilled;
    if (CFG.reloginUseBrowserAutofill && filled === true) return; // booleans only; no Chrome password extraction.
    if (!credential) credential = readSourceCredential();
    if (!credential) throw new Error('no_vault');
    const selector = field === 'email' ? probe.email : probe.pass;
    if (!selector) throw new Error('login_form_not_found');
    recordAttempt();
    await recoveryPulse(state);
    await typeInto(sess, selector, field === 'email' ? credential.email : credential.password);
  };

  try {
    const incident=recoveryIncident(reason);
    if(st.incident&&st.incident.id!==incident.id)recoveryTransition('RECOVERY_RETRY_ELIGIBLE',reason);
    recoveryTransition('SESSION_CHECK',reason);
    await recoveryPulse(state);
    const host = new URL(CFG.cdpUrl).hostname;
    if (!['127.0.0.1','localhost','::1','[::1]'].includes(host)) return finish('cdp_not_local');
    const response = await fetch(CFG.cdpUrl + '/json/list', { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return finish('cdp_unreachable');
    let page = findApprovedWriteHumanTab(await response.json());
    if (!page) return finish('no_tab');
    log('relogin_reusing_tab', { reused:true });
    if (reason === 'visible_login_entry' && (!page || page.webSocketDebuggerUrl !== state.lastObservedPage)) return finish('source_page_changed');
    if (!page || !isApprovedWriteHumanUrl(page.url) || !isApprovedCdpPageSocket(page.webSocketDebuggerUrl)) return finish('untrusted_cdp_page');
    sess = await cdpSession(page.webSocketDebuggerUrl, Math.max(1000,state.recoveryDeadline-monoNow()));
    await sess.send('Page.enable', {}, 5000);
    await sess.send('Runtime.enable', {}, 5000);
    const beforeCookies = await getAllCookiesViaCDP(CFG.cdpUrl, null);
    const beforeHash = hashAuthCookies(filterAuthCookies(beforeCookies, CFG.domain, CFG.ref));
    let didResetAllSessions = false;
    for (let passNumber = 0; passNumber < 2; passNumber++) {
      let fallbackHomepage=null;
      let probe = await probePage(sess);
      if (!isApprovedWriteHumanUrl(probe.href)) return finish('unapproved_login_origin');
      if (probe.authenticated === true && !probe.email && !probe.pass) return finish('already_authenticated');
      const earlyBlock = reason === 'visible_login_entry' ? loginEntryBlock(probe) : recoveryBlock(probe);
      if (earlyBlock) return finish(earlyBlock);
      if (probe.editorBusy) return finish('source_page_busy');
      if(probe.pageReady!==true){
        probe=await waitForRecoveryPage(sess,state,p=>p.loginEvidence||p.loginEntryEvidence||p.authenticated||p.sessionLimit,RELOGIN.reloadWaitMs);
        if(!probe.waitComplete)return finish('page_wait_timeout');
        if(probe.editorBusy)return finish('source_page_busy');
      }
      recoveryTransition('LOGIN_REQUIRED',reason);
      if (reason === 'visible_login_entry' && passNumber === 0 && !probe.loginEvidence && !probe.sessionLimit && probe.loginEntryEvidence !== true) return finish('login_entry_changed');
      // Requested homepage flow: one normal refresh, then wait for a NEW ready
      // document and a stable known page before clicking Login. Preserve forms
      // already populated by the browser and every non-empty/focused editor.
      if(passNumber===0&&probe.loginEntryEvidence&&!readReloginState().incident?.reloaded){
        await recoveryPulse(state);
        const current=await probePage(sess);
        if(loginEntryBlock(current)||current.editorBusy||!current.loginEntryEvidence)return finish('login_entry_changed');
        if(!Number.isFinite(current.documentEpoch))return finish('page_reload_timeout');
        recordAttempt();
        recoveryTransition('RELOAD_ONCE','reload_requested',{reloaded:true});
        await sess.send('Page.reload',{ignoreCache:false},10000);
        const isNewReady=p=>Number.isFinite(p.documentEpoch)&&p.documentEpoch!==current.documentEpoch&&p.pageReady===true&&
          (p.loginEvidence||p.loginEntryEvidence||p.authenticated||p.sessionLimit);
        probe=await waitForRecoveryPage(sess,state,isNewReady,RELOGIN.reloadWaitMs,{phase:'reload_wait',originalEpoch:current.documentEpoch});
        if(!probe.waitComplete)return finish('page_reload_timeout');
        recoveryTransition('PAGE_RELOAD_COMPLETED','reloaded');
      }
      if(!probe.loginEvidence&&!probe.loginEntryEvidence&&!probe.sessionLimit){
        state.logoutEvidence=['provider_session_expired','auth_cookie_absent','startup_auth_cookie_absent'].includes(reason)?reason:null;
        await recheckUnknownSourcePage(state,sess,probe,recordAttempt);
        probe=await waitForRecoveryPage(sess,state,p=>p.loginEvidence||p.loginEntryEvidence||p.authenticated||p.sessionLimit,RELOGIN.hydrationWaitMs);
        if(!probe.waitComplete&&(probe.loginEvidence||probe.loginEntryEvidence||probe.authenticated||probe.sessionLimit||!probe.pageReady))return finish('page_wait_timeout');
      }
      // Preserve already autofilled fields instead of navigating them away.
      if (probe.loginEvidence !== true && !probe.sessionLimit) {
        if(probe.authenticated)return finish('already_authenticated');
        if(probe.editorBusy)return finish('source_page_busy');
        if(probe.loginEntryEvidence && !readReloginState().incident?.navigationClicked){
          recordAttempt();
          await clickLoginEntry(sess,probe,state);
          const clickedDocument={href:probe.href,epoch:probe.documentEpoch};
          probe=await waitForRecoveryPage(sess,state,p=>p.loginEvidence||p.authenticated||p.sessionLimit);
          if(!probe.waitComplete){
            // A no-op visible Login control may still use the configured official
            // route, but only after stable proof that the same idle homepage
            // remains. A loading/changing/foreign document cannot authorize it.
            probe=await waitForRecoveryPage(sess,state,p=>p.loginEntryEvidence&&!p.editorBusy&&
              Number.isFinite(p.documentEpoch)&&p.documentEpoch===clickedDocument.epoch&&p.href===clickedDocument.href,RELOGIN.hydrationWaitMs);
            if(!probe.waitComplete)return finish('page_wait_timeout');
            fallbackHomepage={href:probe.href,epoch:probe.documentEpoch};
          }
        }
      }
      if(probe.loginEvidence!==true&&!probe.sessionLimit&&!probe.authenticated){
        const loginUrl = 'https://writehuman.ai' + CFG.loginPath;
        if (!isApprovedWriteHumanUrl(loginUrl)) return finish('invalid_login_config');
        // A homepage entry only authorizes this normal, same-tab navigation.
        // It is not a confirmed login or a reason to invalidate stored sessions.
        // Charge the existing persisted attempt budget before navigating so a
        // broken login route cannot be hit repeatedly after process restart.
        recordAttempt();
        await recoveryPulse(state);
        const current=await probePage(sess);
        if(current.editorBusy)return finish('source_page_busy');
        if(loginEntryBlock(current))return finish(loginEntryBlock(current));
        if(current.authenticated)return finish('already_authenticated');
        if(current.loginEvidence)return finish('login_form_changed');
        if(!current.pageReady)return finish('page_wait_timeout');
        if(fallbackHomepage&&(!current.loginEntryEvidence||current.href!==fallbackHomepage.href||current.documentEpoch!==fallbackHomepage.epoch))return finish('source_page_changed');
        if(readReloginState().incident?.routeNavigated)return finish('login_form_not_found');
        recoveryTransition('NAVIGATION','login_page_requested',{routeNavigated:true});
        const navigation = await sess.send('Page.navigate', { url: loginUrl }, 10000);
        if (navigation.errorText || navigation.isDownload) return finish('login_navigation_failed');
        log('relogin_navigation', { action:'login_page_requested', same_tab:true });
        // Allow the official login SPA to hydrate and any transient verification
        // scaffolding to settle before concluding a CAPTCHA is required. Do not
        // bypass a real visible challenge: interactive security prompts stop the
        // bounded wait; usable forms must pass consecutive readiness samples.
        probe=await waitForRecoveryPage(sess,state,p=>p.loginEvidence||p.sessionLimit||p.authenticated);
        if(!probe.waitComplete)return finish('page_wait_timeout');
      }
      if (probe.authenticated === true && !probe.email && !probe.pass) return finish('already_authenticated');
      let blocked = recoveryBlock(probe);
      if (blocked) return finish(blocked);
      if (probe.sessionLimit) {
        if (didResetAllSessions) return finish('session_limit_after_reset');
        recordAttempt();
        const reset = await resetSessionLimitOnce(sess);
        if (reset !== 'clicked') return finish(reset);
        didResetAllSessions = true;
        const ready=await waitForRecoveryPage(sess,state,p=>!p.sessionLimit&&(p.loginEvidence||p.loginEntryEvidence||p.authenticated));
        if(!ready.waitComplete)return finish('page_wait_timeout');
        if(ready.sessionLimit)return finish('session_limit_after_reset');
        continue;
      }
      if (probe.loginEvidence !== true || (!probe.email && !probe.pass)) return finish('login_form_not_found');
      recoveryTransition('FORM_READY','existing_form');
      // If only half the form is populated, use one vault identity for both
      // fields. Never combine an unrelated autofilled email with the vault password.
      if(probe.email&&(!probe.pass||!probe.emailFilled||!probe.passwordFilled)){
        credential=readSourceCredential();
        if(credential){recordAttempt();await recoveryPulse(state);await typeInto(sess,probe.email,credential.email);}
      }
      if (probe.email) await fillIfEmpty(probe, 'email');
      if (!probe.pass) {
        if(readReloginState().incident?.emailSubmitted)return finish('password_form_not_found');
        recoveryTransition('EMAIL_SUBMITTED','existing_form',{emailSubmitted:true});
        recordAttempt(); await recoveryPulse(state); await submitLoginForm(sess, probe, state);
        log('relogin_email_submitted', {});
        probe=await waitForRecoveryPage(sess,state,p=>!!p.pass||p.sessionLimit||p.authenticated);
        if(!probe.waitComplete)return finish('password_form_not_found');
      }
      if (!probe.pass) return finish('password_form_not_found');
      probe = await probePage(sess);
      blocked = recoveryBlock(probe); if (blocked) return finish(blocked);
      if(credential){recordAttempt();await recoveryPulse(state);await typeInto(sess,probe.pass,credential.password);}
      else await fillIfEmpty(probe, 'password');
      // Persist uncertainty BEFORE submitting. A crash/timeout cannot cause an
      // automatic duplicate password submission after restart.
      const submission=readReloginState();
      if(submission.incident?.credentialSubmitted)return finish('submission_outcome_unknown');
      recoveryTransition('CREDENTIALS_AVAILABLE',credential?'local_vault':'browser_autofill');
      recordAttempt(); await recoveryPulse(state); await submitLoginForm(sess, probe, state, true);
      log('relogin_submitted', { source: credential ? 'local_vault' : 'browser_autofill' });
      const deadline = Math.min(monoNow() + RELOGIN.authWaitMs,state.recoveryDeadline);
      let repeat = false;
      while (monoNow() < deadline) {
        await sleep(1000); await recoveryPulse(state,deadline);
        if(monoNow()>=deadline)break;
        let after;
        try{after=await probePage(sess,Math.min(12000,Math.max(1000,deadline-monoNow())));}
        catch(e){if(e.message==='cdp_command_failed')continue;throw e;}
        if(!after.href||!isApprovedWriteHumanUrl(after.href))continue; // wait for a bounded normal redirect; never fill there.
        blocked = recoveryBlock(after); if (blocked) return finish(blocked);
        if (after.sessionLimit) {
          if (didResetAllSessions) return finish('session_limit_after_reset');
          const reset = await resetSessionLimitOnce(sess);
          if (reset !== 'clicked') return finish(reset);
          didResetAllSessions = true;
          // The official control can complete the original login after a redirect.
          // Observe that completion; never send a second password in this incident.
          after=await waitForRecoveryPage(sess,state,p=>!p.sessionLimit&&(p.loginEvidence||p.authenticated),RELOGIN.authWaitMs);
          if(after.waitComplete!==true||after.pageReady!==true||recoveryBlock(after)||after.authenticated!==true)return finish('submission_outcome_unknown');
          if(after.sessionLimit)return finish('session_limit_after_reset');
          if(after.loginEvidence)return finish('submission_outcome_unknown');
        }
        const captured = await getAllCookiesViaCDP(CFG.cdpUrl, null);
        const hash = hashAuthCookies(filterAuthCookies(captured, CFG.domain, CFG.ref));
        // Existing stale cookies alone are not a successful password login.
        if (hash && after.pageReady===true && !after.loginEvidence && !after.loginEntryEvidence && !after.email && !after.pass &&
            (after.authenticated===true || hash!==beforeHash)) {
          state.lastHash = null; state.emptyPolls = 0; state.loggedOutSent = false;
          state.visibleLogoutCount = 0; state.nextReloginCheckAt = 0;
          state.quickPollsLeft = Math.max(state.quickPollsLeft || 0, CFG.quickPollFor || 4);
          state.reloginPending = true;
          state.providerUiAuthenticated=after.authenticated===true;
          state.browserLogoutObserved=false;state.lastBrowserState='browser_candidate';
          return finish('browser_authenticated_pending_verification');
        }
      }
      if (repeat) continue;
      return finish('submission_outcome_unknown');
    }
    return finish('auth_not_confirmed_after_session_reset');
  } catch (error) {
    const code = error && error.message;
    const safe = new Set(['no_vault','login_form_not_found','field_not_found_or_bad_origin','field_set_failed','login_form_changed','submit_not_found','submit_still_disabled',
      'source_page_changed','source_page_busy','login_entry_changed','login_navigation_failed','page_reload_timeout','page_wait_timeout','recovery_deadline_exceeded',
      'source_not_authorized','activation_in_progress','relogin_state_unwritable','cdp_ws_error','cdp_ws_closed','cdp_connect_timeout','cdp_session_timeout',
      'cdp_command_failed','cdp_command_timeout','no_profile_proof','wrong_chrome_profile','unapproved_login_origin','unapproved_form_action','ambiguous_login_form',...RELOGIN_TERMINAL]);
    const submitted=readReloginState().incident?.credentialSubmitted;
    return finish(RELOGIN_TERMINAL.includes(code)?code:submitted?'submission_outcome_unknown':safe.has(code)?code:'recovery_exception');
  } finally {
    credential = null;
    if (sess) { try { await sess.send('Runtime.releaseObjectGroup', {objectGroup:'wh-source-login'},1000); } catch (_) {} sess.close(); }
    state.reloginInFlight = false;
    delete state.recoveryDeadline;
    await heartbeatIfDue(state, state.lastHash);
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
    const now=new Date().toISOString();
    // Confirmation and final incident closure are one durable state update.
    // A crash or write failure cannot leave a cleared pending flag with an open
    // password-submitted incident between multiple transition writes.
    const next=Object.assign({},cur,{
      lastOutcome: verdict,
      lastVerdictAt: new Date().toISOString(),
      pendingVerification: !terminal && verdict.startsWith('unconfirmed_') && verdict !== 'unconfirmed_verification_timeout' && verdict !== 'unconfirmed_visible_logout',
      verificationStartedAt: (!terminal && verdict.startsWith('unconfirmed_') && verdict !== 'unconfirmed_verification_timeout' && verdict !== 'unconfirmed_visible_logout')
        ? (cur.verificationStartedAt || cur.lastAttemptAt || null) : null,
      haltedReason: terminal ? verdict : cur.haltedReason,
      haltedAt: terminal ? new Date().toISOString() : cur.haltedAt,
    });
    const stage=verdict==='confirmed'?'SYNC_RESUMED':terminal?'MANUAL_ACTION':cur.pendingVerification?'BACKEND_VERIFICATION_REJECTED':null;
    if(cur.incident&&stage)next.incident={...cur.incident,stage,stageAt:now,...(verdict==='confirmed'?{closed:true}:{})};
    if(!writeReloginState(next))return false;
    if(cur.incident&&stage){
      if(verdict==='confirmed')logRecoveryTransition(cur,next.incident,'BACKEND_VERIFIED','confirmed');
      logRecoveryTransition(cur,next.incident,stage,safeCode(verdict)||'rejected');
    }
    return true;
  } catch (_) { return false; }
}

function persistRecoveryVerdict(state,verdict,incidentId){
  if(noteReloginVerdict(verdict)){
    state.reloginPending=readReloginState().pendingVerification===true;
    delete state.recoveryVerdictToPersist;
    if(verdict==='confirmed')log('relogin_confirmed',{promoted:true,result:'PROMOTED'});
    return true;
  }
  state.recoveryVerdictToPersist={verdict,incidentId};
  log('recovery_transition',{incident_id:incidentId,stage:'RECOVERY_BLOCKED',event:'MANUAL_INTERVENTION_REQUIRED',reason:'relogin_state_unwritable',manual_required:true});
  return false;
}

// A provider/browser session can remain on the same cookie bytes even after
// login; the backend's UNCHANGED reply is NOT a verified recovery. Monitor for
// a later rotated candidate, but do not leave the workflow pending forever.
// This deadline persists across restarts; it does not consume another login
// attempt, alter any account session or clear a security halt.
function expireRecoveryVerification(state) {
  if (!state.reloginPending) return false;
  const saved = readReloginState();
  // Older releases persisted only pendingVerification and retry timestamps.
  // Inherit that existing attempt's time instead of prematurely declaring a
  // legitimate one-second-old post-login session timed out after an upgrade.
  const lastAttemptMs = (saved.attempts || []).filter(Number.isFinite).reduce((a,b)=>Math.max(a,b),0);
  const startedAt = Date.parse(saved.verificationStartedAt || saved.lastAttemptAt ||
    (lastAttemptMs ? new Date(lastAttemptMs).toISOString() : '') || saved.lastVerdictAt || '');
  const now = Date.now();
  if (Number.isFinite(startedAt) && startedAt <= now && now - startedAt < RELOGIN.verificationTimeoutMs) return false;
  if(!persistRecoveryVerdict(state,saved.incident?.credentialSubmitted?'submission_outcome_unknown':'unconfirmed_verification_timeout',saved.incident?.id||null))return false;
  log('relogin_verification_timeout', { reason: Number.isFinite(startedAt) ? 'deadline_reached' : 'missing_start_time' });
  return true;
}

// Mask an account for logs: never the full address.
function maskAccount(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return '***';
  return s.slice(0, 1) + '****' + s.slice(at);
}


async function pushIfChanged(state) {
  try { return await pushIfChangedInner(state); }
  finally { await heartbeatIfDue(state, state.lastHash); }
}

function deferCandidateVerification(state,hash){
  const previous=state.candidateRetry;
  const attempts=previous?.hash===hash?Math.min(previous.attempts+1,10):1;
  const delay=Math.min(CFG.maxBackoffMs,Math.max(30000,CFG.pollMs)*2**(attempts-1));
  state.candidateRetry={hash,attempts,nextAt:monoNow()+delay};
  const saved=readReloginState();
  if(saved.lastOutcome!=='state_unreadable')writeReloginState({...saved,candidateRetry:{hash,attempts,nextAt:Date.now()+delay}});
  state.lastHeartbeatAt=monoNow();
  log('candidate_verification_deferred',{reason:'VERIFICATION_INCONCLUSIVE',attempt:attempts,next_ms:delay});
}

async function pushIfChangedInner(state) {
  if(!state.candidateRetryLoaded){
    state.candidateRetryLoaded=true;
    const retry=readReloginState().candidateRetry;
    if(retry&&/^[a-f0-9]{64}$/.test(String(retry.hash))&&Number.isFinite(retry.nextAt)&&Number.isInteger(retry.attempts)&&retry.attempts>0)
      state.candidateRetry={hash:retry.hash,attempts:Math.min(retry.attempts,10),nextAt:monoNow()+Math.max(0,Math.min(CFG.maxBackoffMs,retry.nextAt-Date.now()))};
  }
  if (!state.reloginStateLoaded) {
    state.reloginStateLoaded = true;
    state.reloginPending = !!state.reloginPending || readReloginState().pendingVerification === true;
  }
  if(state.recoveryVerdictToPersist){
    const queued=state.recoveryVerdictToPersist;
    if((readReloginState().incident?.id||null)!==queued.incidentId)delete state.recoveryVerdictToPersist;
    else if(!persistRecoveryVerdict(state,queued.verdict,queued.incidentId))return;
  }
  expireRecoveryVerification(state);
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
  state.cdp='DOWN';state.chrome=false;state.cookieReadOk=false;
  try {
    cookies = await getAllCookiesViaCDP(CFG.cdpUrl, state);
    state.cdp = '200'; state.chrome = true; state.lastError = null; state.cdpFails = 0;state.cookieReadOk=true;
    // Update before any early return from a browser-state/recovery branch.
    state.authCount = filterAuthCookies(cookies, CFG.domain, CFG.ref).length;
  } catch (e) {
    const reason=recordCdpFailure(state,e);
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
    if (reason==='cdp_unreachable' && CFG.autoLaunchChrome && state.isActiveSource === true
        && state.cdpFails >= CFG.cdpRelaunchAfter && (monoNow() - (state.lastRelaunchAt || 0)) > CFG.relaunchCooldownMs) {
      state.lastRelaunchAt = monoNow();
      relaunchChrome('cdp_auto');
    }
    await postToServer(state, { heartbeat: true, hash: null }); // report CDP-down so the dashboard sees it live
    return;
  }

  // Cookie transport and visible authentication are distinct. A stale cookie hash
  // must never suppress inspection of a real signed-out source login form forever.
  const observed = await inspectSourceLoginPage(state);
  if (observed && observed.rechecked) return; // Re-read cookies after the refreshed document.
  if (observed && observed.loginEntry) {
    // Homepage login entry is not a provider-authenticated browser session.
    state.authCount = 0;
    if(!Object.hasOwn(state,'loggedOutCookieHash'))state.loggedOutCookieHash=hashAuthCookies(filterAuthCookies(cookies,CFG.domain,CFG.ref));
    if (observed.entryConfirmed) await attemptSourceRelogin(state, 'visible_login_entry');
    return; // A navigation check never expires or overwrites the backend vault.
  }
  if (observed && observed.visibleLogout) {
    state.authCount = 0;
    if(!Object.hasOwn(state,'loggedOutCookieHash'))state.loggedOutCookieHash=hashAuthCookies(filterAuthCookies(cookies,CFG.domain,CFG.ref));
    if (observed.confirmed) {
      if (state.reloginPending) return;
      await attemptSourceRelogin(state, 'visible_login_form');
    }
    return; // finally still reports liveness; don't re-publish stale logged-out cookies.
  }
  // A page-check interval, unavailable target or transport error is not evidence
  // that a previously logged-out browser authenticated. Keep stale bytes blocked.
  if(state.browserLogoutObserved || (!observed && ['login_required','login_entry'].includes(state.lastBrowserState))){
    const p=observed?.probe,candidateHash=hashAuthCookies(filterAuthCookies(cookies,CFG.domain,CFG.ref));
    // Manual/delayed login can land on an avatar-only editor. Fresh bytes on a
    // ready, approved page are a candidate for the backend, never local proof.
    const freshCandidate=p&&p.pageReady===true&&!p.loginEvidence&&!p.loginEntryEvidence&&!p.sessionLimit&&!recoveryBlock(p)
      &&Object.hasOwn(state,'loggedOutCookieHash')&&candidateHash&&candidateHash!==state.loggedOutCookieHash;
    if(!freshCandidate)return;
    state.lastBrowserState='browser_candidate';
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
        // With recovery enabled, a local cookie loss is not proof that the
        // server's still-verified session has expired. Recover first; do not
        // disrupt existing clients by unconditionally downgrading their vault.
        if (CFG.reloginEnabled && state.isActiveSource === true) {
          const now = Date.now();
          if (now >= (state.nextReloginCheckAt || 0)) {
            state.nextReloginCheckAt = now + Math.max(5 * 60000, RELOGIN.cooldownMs);
            const outcome = await attemptSourceRelogin(state, 'auth_cookie_absent').catch(() => 'error');
            if (outcome === 'browser_authenticated_pending_verification') return;
          }
        } else if (!CFG.reloginEnabled) {
          // Legacy behaviour unchanged when automatic recovery is disabled.
          const r = await postToServer(state, { loggedOut: true, reason: 'auth_cookie_absent' });
          if (r && !r._err && r._status == null) { state.loggedOutSent = true; log('logout_signaled', { after_polls: state.emptyPolls }); }
        }
      } else if (heartbeatDue(state)) {
        state.lastHeartbeatAt = monoNow();
        await postToServer(state, { heartbeat: true, hash: null });
        log('browser_not_authenticated', { auth_cookies: 0, empty_polls: state.emptyPolls });
      }
    } else {
      // STARTUP RECOVERY: the Agent can start while the source Chrome is already
      // logged out. lastHash is in-memory and null after every process restart.
      // Gate on the server-confirmed ACTIVE source and the explicit opt-in.
      // This MUST NOT mark the server's existing vault expired: a missing local
      // cookie alone cannot prove that client sessions were revoked.
      if (CFG.reloginEnabled && state.isActiveSource === true) {
        state.emptyPolls = (state.emptyPolls || 0) + 1;
        const now = Date.now();
        if (state.emptyPolls >= CFG.logoutDebounce && now >= (state.nextReloginCheckAt || 0)) {
          state.nextReloginCheckAt = now + Math.max(5 * 60000, RELOGIN.cooldownMs);
          const outcome = await attemptSourceRelogin(state, 'startup_auth_cookie_absent').catch(() => 'error');
          if (outcome === 'browser_authenticated_pending_verification') return;
        }
      }
      if (heartbeatDue(state)) {
        state.lastHeartbeatAt = monoNow();
        await postToServer(state, { heartbeat: true, hash: null });
        log('browser_not_authenticated', { auth_cookies: 0 });
      }
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
  if(state.candidateRetry?.hash!==hash)delete state.candidateRetry;
  if(state.candidateRetry&&monoNow()<state.candidateRetry.nextAt)return;
  const recoveryWasPending=state.reloginPending===true,recoveryId=readReloginState().incident?.id||null;
  const r = await postToServer(state, { cookies: auth });
  if(recoveryWasPending&&(readReloginState().incident?.id||null)!==recoveryId)return;
  if (r && r._err) { log('ingest_post_failed', { error: r._err }); return; }     // lastHash is still cleared → retried next tick
  if (r && r._status) {
    // A REFUSED candidate is a real outcome, not a transport failure: record the server's reason
    // and stop re-offering the same bundle, or the agent would push a rejected candidate forever.
    // STALE_BUNDLE in particular is normal and healthy — it just means another device is ahead.
    const code = (r.body && r.body.code) || r.code || null;
    if(code==='VERIFICATION_INCONCLUSIVE')deferCandidateVerification(state,hash);
    if (code === 'STALE_BUNDLE' || code === 'ACCOUNT_MISMATCH' || code === 'REPLAY_REJECTED') state.lastHash = hash;
    log('ingest_rejected', { status: r._status, code, token_exp: authTokenExpiry(auth, CFG.ref) });
    if(code==='ACCOUNT_MISMATCH'){
      persistRecoveryVerdict(state,'wrong_account',recoveryId);
      log('relogin_rejected_by_server',{code,action:'wrong_account'});
      return;
    }

    // ── a recovery awaiting its verdict was REJECTED ──────────────────────────
    // attemptSourceRelogin() only ever reports that the BROWSER re-authenticated;
    // the account's identity is decided here, by the server. ACCOUNT_MISMATCH means
    // we signed a DIFFERENT account in, so the recovery was not a success at all:
    // halt permanently rather than leaving a wrong account logged in and retrying.
    if (state.reloginPending) {
      state.reloginPending = code !== 'ACCOUNT_MISMATCH' && !state.standDown;
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
  if(r.code==='VERIFICATION_INCONCLUSIVE'){
    deferCandidateVerification(state,hash);
    if(state.reloginPending)noteReloginVerdict('unconfirmed_VERIFICATION_INCONCLUSIVE');
    return;
  }
  delete state.candidateRetry;
  const acceptedState=readReloginState();
  if(acceptedState.candidateRetry){delete acceptedState.candidateRetry;writeReloginState(acceptedState);}
  state.lastHash = hash;
  state.lastHeartbeatAt = monoNow();   // a push IS contact; no extra beat needed right after
  // A genuine change happened — poll faster for a short window to catch the follow-up rotation.
  state.quickPollsLeft = CFG.quickPollFor;
  // The server ACCEPTED the bundle, which means candidateSync completed its
  // provider-authenticated verify AND its expectedAccountId match. Only now is a
  // recovery actually complete - this is the one place that may call it confirmed.
  if (state.reloginPending) {
    state.reloginPending = true;
    // A 2xx HEARTBEAT or STANDBY_ROUTINE_REFRESH is not proof of an approved
    // account. Only an ACTIVE source's verified PROMOTED candidate confirms it.
    if (r.code === 'PROMOTED' && r.promoted === true && r.isActiveSource === true && !r.standDown) {
      persistRecoveryVerdict(state,'confirmed',recoveryId);
    } else {
      noteReloginVerdict('unconfirmed_' + String(r.code || 'response'));
      log('relogin_unconfirmed', { code: r.code || null });
    }
  }
  const verified=r.code==='PROMOTED'&&r.promoted===true&&r.isActiveSource===true&&!r.standDown;
  if(verified){state.browserLogoutObserved=false;delete state.loggedOutCookieHash;}
  log(verified?'cookie_synchronized':'candidate_acknowledged', {
    hash: hash.slice(0, 8), changed: r.changed, result: r.code || r.result,
    token_exp: authTokenExpiry(auth, CFG.ref),
    promoted: r.promoted === true, source_switched: r.sourceSwitched === true,
    active_source: (r.activeSource && r.activeSource.name) || null,
    is_active_source: r.isActiveSource === true,
  });
}

// ── single-instance lock (PID + heartbeat file) ───────────────────────────────
// A kernel IPC reservation serializes startup and stale PID-file replacement.
// The PID file remains status telemetry. A live PID is never displaced merely
// because its heartbeat is old; release removes only our own recorded owner.
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
  if(singletonGuard){singletonGuard.close();singletonGuard=null;}
}
let singletonGuard=null;
function reserveProcessGuard(){
  // A kernel-owned pipe survives neither a crash nor a reboot. Acquiring it is
  // atomic across starters; the PID file remains compatible status telemetry.
  const windows=os.platform()==='win32',lockPath=path.resolve(CFG.lockFile);
  const key=crypto.createHash('sha256').update(windows?lockPath.toLowerCase():lockPath).digest('hex');
  const name=windows?'\\\\.\\pipe\\WriteHumanAgent-'+key:'\0WriteHumanAgent-'+key;
  return new Promise(resolve=>{
    const server=require('net').createServer(socket=>socket.destroy());
    const fail=()=>{try{server.close();}catch(_){}log('lock_error',{code:'state_unwritable'});resolve(null);};
    server.once('error',fail);
    // Node24 Windows libuv has a duplicate-bind crash when this internal tuning
    // variable is inherited. Use the default during the synchronous bind only.
    const inherited=process.env.NODE_PENDING_PIPE_INSTANCES;
    try{
      if(windows)delete process.env.NODE_PENDING_PIPE_INSTANCES;
      server.listen(name,()=>{server.unref();resolve(server);});
    }catch(_){fail();}finally{
      if(windows&&inherited!==undefined)process.env.NODE_PENDING_PIPE_INSTANCES=inherited;
    }
  });
}
// true = we hold the lock; false = a live agent already holds it.
async function acquireLock() {
  if(singletonGuard)return false;
  const guard=await reserveProcessGuard();if(!guard)return false;
  let owned=false;
  try{
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(CFG.lockFile, 'wx');   // atomic create — only one racer wins
      try{fs.writeSync(fd, lockPayload());}finally{fs.closeSync(fd);}
      singletonGuard=guard;owned=true;return true;
    } catch (e) {
      if (e.code !== 'EEXIST') { log('lock_error', { code:'state_unwritable' }); return false; }
      let holder = 0, ageMs = Infinity;
      try {
        const cur = JSON.parse(fs.readFileSync(CFG.lockFile, 'utf8'));
        holder = parseInt(cur && cur.pid, 10) || 0;
        const at = cur && Date.parse(cur.at);
        ageMs = Number.isFinite(at) ? (Date.now() - at) : (Date.now() - fs.statSync(CFG.lockFile).mtimeMs);
      } catch (_) { try { ageMs = Date.now() - fs.statSync(CFG.lockFile).mtimeMs; } catch (_) {} }
      // Live duplicate: known holder, PID alive, and the heartbeat is fresh.
      if (holder && pidAlive(holder)) return false;
      // Unknown holder but the lock was written a heartbeat ago (a racing starter mid-write): defer.
      if (!holder && ageMs < 5000) return false;
      try { fs.unlinkSync(CFG.lockFile); } catch (_) {}   // stale (dead/old/corrupt) -> clear + retry
    }
  }
  return false;
  }finally{if(!owned)guard.close();}
}

// Explicit, versioned consent for the official provider's session-limit control.
// This does not clear a halt, reset a budget, submit credentials, or call a server.
async function authorizeSessionLimitRecovery(acknowledged){
  if(acknowledged!==true)return {ok:false,code:'operator_ack_required'};
  if(process.platform!=='win32')return {ok:false,code:'unsupported_platform'};
  const flag=process.env.WHV2_SESSION_LIMIT_SIGNOUT_ALL,consent=process.env.WHV2_SESSION_LIMIT_CONSENT;
  if((flag!=null&&flag!==''&&!/^(1|true|yes)$/i.test(flag.trim()))||
      (consent!=null&&consent!==''&&consent!=='official-provider-session-limit-v1'))return {ok:false,code:'configuration_override_conflict'};
  if(!await acquireLock())return {ok:false,code:'lock_unavailable'};
  let temp;
  try{
    const original=fs.readFileSync(CONFIG_PATH,'utf8'),cfg=JSON.parse(original.replace(/^\uFEFF/,''));
    if(!cfg||typeof cfg!=='object'||Array.isArray(cfg))return {ok:false,code:'configuration_unreadable'};
    fs.writeFileSync(CONFIG_PATH+'.consent-'+crypto.randomUUID()+'.json',original,{flag:'wx',mode:0o600});
    const next={...cfg,sessionLimitSignOutAll:true,sessionLimitConsent:'official-provider-session-limit-v1',
      sessionLimitConsentAt:new Date().toISOString()};
    temp=CONFIG_PATH+'.consent-'+crypto.randomUUID()+'.tmp';
    const fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(next,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,CONFIG_PATH);
    return {ok:true,code:'session_limit_consent_saved',maxResetsPer24h:1,
      scope:'Official WriteHuman session-limit message and exact Sign out all control only; all account sessions may be signed out.'};
  }catch(_){return {ok:false,code:'configuration_write_failed'};}
  finally{if(temp)try{fs.unlinkSync(temp);}catch(_){}releaseLock();}
}

// Explicit operator action only; never called by the poll loop or an upgrade.
// It acknowledges a manually resolved challenge, without solving/bypassing one.
async function acknowledgeResolvedChallenge(acknowledged){
  if(acknowledged!==true)return {ok:false,code:'operator_ack_required'};
  if(process.platform!=='win32')return {ok:false,code:'unsupported_platform'};
  if(!await acquireLock())return {ok:false,code:'lock_unavailable'};
  try{
    const file=reloginStatePath(),original=fs.readFileSync(file,'utf8');
    const current=JSON.parse(original.replace(/^\uFEFF/,''));
    if(!current||typeof current!=='object'||Array.isArray(current))return {ok:false,code:'state_unreadable'};
    for(const key of ['attempts','sessionLimitResets'])if(current[key]!=null&&(!Array.isArray(current[key])||!current[key].every(Number.isFinite)))return {ok:false,code:'state_unreadable'};
    if(current.pendingVerification!=null&&typeof current.pendingVerification!=='boolean')return {ok:false,code:'state_unreadable'};
    if(current.incident!=null&&(typeof current.incident!=='object'||Array.isArray(current.incident)))return {ok:false,code:'state_unreadable'};
    for(const key of ['credentialSubmitted','closed'])if(current.incident?.[key]!=null&&typeof current.incident[key]!=='boolean')return {ok:false,code:'state_unreadable'};
    if(!['captcha_required','mfa_required'].includes(current.haltedReason))return {ok:false,code:'security_review_required'};
    if(current.pendingVerification===true||(current.incident?.credentialSubmitted===true&&current.incident.closed!==true))return {ok:false,code:'submission_unresolved'};
    // Keep an exact sibling snapshot and every counter/unknown extension field.
    // A failure to back up or atomically write leaves the existing halt in place.
    fs.writeFileSync(file+'.review-'+crypto.randomUUID()+'.json',original,{flag:'wx',mode:0o600});
    const next={...current,haltedReason:null,haltedAt:null,captchaHaltPreSubmit:false,lastBlock:null,lastOutcome:'challenge_review_acknowledged',
      lastChallengeReview:{at:new Date().toISOString(),reason:current.haltedReason}};
    if(current.incident)next.incident={...current.incident,closed:true};
    if(!writeReloginState(next))return {ok:false,code:'state_unwritable'};
    return {ok:true,code:'challenge_review_acknowledged',budgetsPreserved:true,
      note:'No login was attempted. Security checks and retry limits remain enforced when the Agent restarts.'};
  }catch(_){return {ok:false,code:'state_unreadable'};}
  finally{releaseLock();}
}

// Acquire the single-instance lock, then hand off to run(). A duplicate is not an error (it's
// correctly refused), so we exit 0 — the supervisor won't flap-restart on a benign double-launch.
async function start() {
  if (!await acquireLock()) {
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

  log('relogin_policy', { enabled:CFG.reloginEnabled, sign_out_all_enabled:CFG.sessionLimitSignOutAll, page_check_ms:CFG.reloginPageCheckMs, idle_recheck_ms:CFG.reloginPageRecheckMs });

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
  attemptSourceRelogin, noteReloginVerdict, readReloginState, writeReloginState, readSourceCredential, reloginReport, maskAccount, reloginStatePath, RELOGIN, RELOGIN_TERMINAL,
  isApprovedWriteHumanUrl, findApprovedWriteHumanTab, isApprovedCdpPageSocket, cdpNewTabUrl, pushIfChanged,
  resetSessionLimitOnce, RELOGIN_PROBE, SIGNOUT_ALL_CONFIRMED_EXPRESSION, connectionStatus, recoveryDiagnostics,
  cdpSession, probePage, inspectSourceLoginPage, recheckUnknownSourcePage, heartbeatIfDue, recoveryBlock, submitLoginForm, typeInto, acknowledgeResolvedChallenge, recheckStaleCaptchaHalt, authorizeSessionLimitRecovery };

if (require.main === module) start();
