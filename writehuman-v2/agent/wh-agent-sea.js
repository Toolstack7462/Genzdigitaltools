'use strict';
/**
 * WriteHuman Universal Agent — single-executable entry point (Node SEA).
 *
 * This one file is compiled into WriteHuman-Agent-Setup-x64.exe. It is BOTH the installer and the
 * agent, chosen at runtime by where it is running from:
 *
 *   run from anywhere except the install dir  ->  INSTALL: copy self into %LOCALAPPDATA%, make the
 *                                                 dirs, register a per-user logon task, launch the
 *                                                 installed copy, exit. No admin rights, no Node,
 *                                                 no PowerShell for the user to type.
 *   run from the install dir                  ->  AGENT: run the real cookie-sync agent, whose code
 *                                                 is carried as a bundled SEA asset so there is ONE
 *                                                 source of truth (cookie-sync-agent.js), never a
 *                                                 forked copy that can drift.
 *
 * The agent's own singleton lock still guarantees one instance even if the exe is double-clicked
 * again after installation.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP_DIR_NAME = path.join('GenZDigitalTools', 'WriteHumanAgent');
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_DIR_NAME);
const INSTALLED_EXE = path.join(INSTALL_DIR, 'WriteHumanAgent.exe');
const TASK_NAME = 'WriteHumanUniversalAgent';
const AGENT_ASSET = 'cookie-sync-agent.js';

// Everything an install OWNS, named once so the uninstaller cannot miss a piece. The previous
// `--uninstall` removed three shortcuts and left every one of these behind — the running agent
// included, still holding a live credential and still auto-starting at the next logon.
const CREDS_DIR = path.join(INSTALL_DIR, 'creds');
const CREDS_FILE = path.join(CREDS_DIR, 'agent-device.json');
const STAND_DOWN_FILE = path.join(CREDS_DIR, 'stood-down.json');
const CONFIG_FILE = path.join(INSTALL_DIR, 'config.json');
const LOCK_FILE = path.join(INSTALL_DIR, 'agent.lock');
const INSTALLED_MARKER = path.join(INSTALL_DIR, 'installed.json');
// Where Windows lists installed software for the current user. A per-user install with no entry
// here is, as far as the operator can tell, not uninstallable at all — which is exactly how an RDP
// ends up with an agent nobody can remove.
const UNINSTALL_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GenZWriteHumanAgent';
const DISPLAY_NAME = 'WriteHuman Agent (Gen Z Digital Store)';

// SEA runtime handle (present only inside the built exe; absent when run as a plain script in dev).
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea || !sea.isSea()) sea = null; } catch (_) { sea = null; }

function log(...a) { try { console.log('[wh-setup]', ...a); } catch (_) {} }

/** The agent source: from the bundled asset in the exe, else the sibling file in dev. */
function agentSource() {
  if (sea) return sea.getAsset(AGENT_ASSET, 'utf8');
  return fs.readFileSync(path.join(__dirname, AGENT_ASSET), 'utf8');
}

/** The agent version carried INSIDE this exe, read from the bundled asset. */
function selfAgentVersion() {
  try { return (agentSource().match(/AGENT_VERSION\s*=\s*'([^']+)'/) || [])[1] || null; }
  catch (_) { return null; }
}
/** The version recorded by whichever installer last wrote INSTALLED_EXE. */
function installedAgentVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'installed.json'), 'utf8')).agentVersion || null; }
  catch (_) { return null; }
}
/** Stamp what we just installed, so the next run can compare versions instead of guessing. */
function writeInstalledMarker() {
  try {
    fs.writeFileSync(path.join(INSTALL_DIR, 'installed.json'),
      JSON.stringify({ agentVersion: selfAgentVersion(), installedAt: new Date().toISOString() }, null, 2),
      { encoding: 'ascii' });
  } catch (_) { /* non-fatal: worst case the next run treats this as an upgrade and repairs */ }
}

/**
 * Tee console output to logs\agent.log. In SEA agent mode there is no run-agent.cmd wrapper to
 * redirect stdout, and the logon shortcut launches the exe detached, so without this the agent's
 * (already timestamped, cookie-value-free) log lines would go nowhere — which is exactly how a
 * silent failure hides. Bounded so it cannot grow without limit.
 */
function attachLogFile() {
  try {
    const logDir = path.join(INSTALL_DIR, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'agent.log');
    try { if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) fs.renameSync(logPath, logPath + '.1'); } catch (_) {}
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    const tee = (orig) => (...args) => {
      try { stream.write(args.map(String).join(' ') + '\n'); } catch (_) {}
      try { orig(...args); } catch (_) {}
    };
    console.log = tee(console.log.bind(console));
    console.error = tee(console.error.bind(console));
  } catch (_) { /* logging is best-effort; never block the agent on it */ }
}

/** Run the bundled agent in THIS process. Its own module scope, its own require. */
function runAgent() {
  attachLogFile();
  const Module = require('module');
  const src = agentSource();
  const m = new Module(INSTALLED_EXE, null);
  m.filename = path.join(INSTALL_DIR, AGENT_ASSET);
  m.paths = Module._nodeModulePaths(INSTALL_DIR);
  // The agent guards its own start with `require.main === module`; give it that so it boots.
  process.env.WHV2_CONFIG = process.env.WHV2_CONFIG || path.join(INSTALL_DIR, 'config.json');
  m._compile(src.replace('if (require.main === module) start();', 'start();'), m.filename);
}

function selfPath() { return process.execPath; }   // the running exe

/**
 * Am I the INSTALLED copy? If so this run is the agent, not an installer.
 *
 * This is a question about identity — which file am I — so it is answered by the path alone. It
 * used to also compare file SIZE, which is the same mistake `installedSameBuild` had to be fixed
 * for: a ~91 MB SEA where only kilobytes differ between versions makes size a coin flip, and here
 * it could send the installed exe down the INSTALLER path (or, on a size collision, the reverse).
 */
function alreadyInstalledAndCurrent() {
  try {
    return path.resolve(selfPath()).toLowerCase() === path.resolve(INSTALLED_EXE).toLowerCase();
  } catch (_) { return false; }
}

function ensureDirs() {
  for (const d of [INSTALL_DIR, path.join(INSTALL_DIR, 'logs'), path.join(INSTALL_DIR, 'config'), path.join(INSTALL_DIR, 'creds')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ── Dedicated "WriteHuman Chrome" ────────────────────────────────────────────
// A separate persistent profile, its own debug port, localhost-only. Ported from the proven RDP
// launcher (commit e30b9ba) with ONE deliberate change for a personal machine: the original did
// `taskkill /im chrome.exe /f`, which is fine on a dedicated RDP but would kill the user's everyday
// Chrome here. This kills ONLY the process holding OUR user-data-dir, and clears only OUR lock, so
// the everyday profile is never touched.
const CHROME_ROOT = path.join(path.dirname(INSTALL_DIR), 'WriteHumanChrome');
const CHROME_PROFILE_DIR = path.join(CHROME_ROOT, 'UserData');
const DEFAULT_CDP_PORT = 9315;   // not Chrome's usual 9222, to avoid colliding with any other tool

function readCfg() { try { return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'config.json'), 'utf8')); } catch (_) { return {}; } }
function cdpPort() { const m = String(readCfg().cdpUrl || '').match(/:(\d+)/); return m ? Number(m[1]) : DEFAULT_CDP_PORT; }

async function cdpUp(port, timeoutMs) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(timeoutMs || 3000) });
    return r.ok;
  } catch (_) { return false; }
}

function findChromeExe() {
  const cands = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

/** Kill ONLY chrome.exe processes whose command line contains our dedicated user-data-dir. */
function killOurStrayChrome() {
  try {
    const needle = CHROME_PROFILE_DIR.toLowerCase();
    // WMIC is deprecated but universally present; the CIM query returns pid+commandline.
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      "Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains(" + JSON.stringify(needle) + ") } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 15000 });
  } catch (_) {}
}

/**
 * Idempotent launch of the dedicated WriteHuman Chrome.
 *   - CDP already up  -> no-op (never disturbs a healthy session, never a second instance).
 *   - otherwise       -> kill only OUR stray chrome, clear OUR lock, launch with the debug +
 *                        anti-throttle flags, poll until the port opens, retry up to 3x.
 * The anti-throttle flags keep WriteHuman's Supabase auto-refresh timer alive when the desktop is
 * locked/occluded, so the browser rotates its token before it expires — the whole reason the
 * original RDP stayed logged in for weeks.
 */
async function launchChrome() {
  const port = cdpPort();
  if (await cdpUp(port, 4000)) { log('WriteHuman Chrome already running (CDP up on', port + ')'); return true; }
  const exe = findChromeExe();
  if (!exe) { log('Chrome not found — install Google Chrome, then reopen WriteHuman Chrome'); return false; }
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  const args = [
    '--user-data-dir=' + CHROME_PROFILE_DIR,
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1',   // bind CDP to loopback only, never public
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-session-crashed-bubble',
    'https://writehuman.ai',
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    killOurStrayChrome();
    await new Promise(r => setTimeout(r, 1500));
    for (const lk of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
      try { fs.unlinkSync(path.join(CHROME_PROFILE_DIR, lk)); } catch (_) {}
    }
    try { spawn(exe, args, { detached: true, stdio: 'ignore' }).unref(); } catch (e) { log('chrome spawn failed:', e.message); }
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 2000));
      if (await cdpUp(port, 3000)) { log('WriteHuman Chrome up on', port, '(attempt', attempt + ')'); return true; }
    }
    log('attempt', attempt, 'did not open CDP', port + '; retrying');
  }
  log('ERROR: WriteHuman Chrome CDP did not open after 3 attempts');
  return false;
}

/** Create Start-Menu and Desktop shortcuts named "WriteHuman Chrome" -> exe --launch-chrome. */
function createChromeShortcuts() {
  const targets = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WriteHuman Chrome.lnk'),
    path.join(os.homedir(), 'Desktop', 'WriteHuman Chrome.lnk'),
  ].filter(t => t && !t.startsWith('undefined'));
  for (const lnk of targets) {
    const ps = [
      '$w = New-Object -ComObject WScript.Shell;',
      '$s = $w.CreateShortcut(' + JSON.stringify(lnk) + ');',
      '$s.TargetPath = ' + JSON.stringify(INSTALLED_EXE) + ';',
      "$s.Arguments = '--launch-chrome';",
      '$s.WorkingDirectory = ' + JSON.stringify(INSTALL_DIR) + ';',
      '$s.Description = ' + JSON.stringify('Open the dedicated WriteHuman Chrome') + ';',
      '$s.Save();',
    ].join(' ');
    try { spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 15000 }); } catch (_) {}
  }
}

/** Write config.json only if absent, so a reinstall never clobbers a working setup. */
function writeDefaultConfig() {
  const cfgPath = path.join(INSTALL_DIR, 'config.json');
  if (fs.existsSync(cfgPath)) return;
  const cfg = {
    ingestUrl: process.env.WHV2_INGEST_URL || 'https://api.genzdigitalstore.com/api/crm/proxy/agent/writehuman/cookies',
    cdpUrl: 'http://127.0.0.1:' + DEFAULT_CDP_PORT,
    deviceName: os.hostname(),
    // Pin the connector to the dedicated profile so it refuses to read any OTHER Chrome profile.
    chromeProfile: CHROME_PROFILE_DIR.replace(/\\/g, '/'),
    // The connector asks the exe to (re)launch this managed Chrome when CDP is down — safe here
    // because it is our OWN dedicated profile, never the user's everyday Chrome.
    autoLaunchChrome: true,
    chromeLauncher: INSTALLED_EXE.replace(/\\/g, '/'),
    deviceStateFile: path.join(INSTALL_DIR, 'creds', 'agent-device.json').replace(/\\/g, '/'),
    lockFile: path.join(INSTALL_DIR, 'agent.lock').replace(/\\/g, '/'),
    pollMs: 45000,
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { encoding: 'ascii' });
}

// ── credential health, identity lifecycle, uninstall ─────────────────────────
//
// THE BUG THIS SECTION EXISTS FOR. Re-running the installer on a machine whose device row had been
// revoked used to "succeed": it copied the exe, kept `creds/agent-device.json` exactly as it was,
// and started the agent with the SAME revoked credential. The agent then 403'd on every request
// for ever, and no fresh authorization was ever offered. On the operator's screen that is
// "reinstalling doesn't fix it"; in the log it is one `stand_down {"code":"DEVICE_REVOKED"}` line
// and then silence.
//
// The installer now ASKS the server what it thinks of this machine's credential before deciding
// what kind of install this is.

function readInstalledCfg() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; } }
function readCreds() { try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch (_) { return null; } }

/** …/agent/writehuman/cookies -> …/agent/writehuman/<endpoint> */
function apiUrl(endpoint) {
  const ingest = String(readInstalledCfg().ingestUrl
    || process.env.WHV2_INGEST_URL
    || 'https://api.genzdigitalstore.com/api/crm/proxy/agent/writehuman/cookies');
  return ingest.replace(/\/cookies\/?$/, '/' + endpoint);
}

/**
 * What does the SERVER think of the credential sitting on this machine?
 *
 * Returns one of:
 *   { have:false }                              nothing installed here yet
 *   { have:true, ok:true,  state }              healthy — repair in place, keep the identity
 *   { have:true, ok:false, reauthorize:true }   revoked / uninstalled / superseded / unknown
 *   { have:true, unreachable:true }             we could not ask; assume nothing, change nothing
 *
 * `unreachable` is treated as "leave the identity alone" on purpose. A network blip must never
 * destroy a working enrolment — the cost of guessing wrong in that direction is an agent that
 * needs a fresh admin authorization for no reason.
 */
async function probeCredential() {
  const creds = readCreds();
  const localStandDown = fs.existsSync(STAND_DOWN_FILE);
  if (!creds || !creds.deviceId || !creds.deviceKey) {
    return { have: false, localStandDown };
  }
  try {
    const r = await fetch(apiUrl('device-status'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': creds.deviceId, 'x-agent-key': creds.deviceKey },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    let body = null; try { body = await r.json(); } catch (_) {}
    if (r.ok && body && body.ok) return { have: true, ok: true, state: body.deviceState || null, deviceId: creds.deviceId, localStandDown };
    if (r.status === 403 && body) {
      return { have: true, ok: false, reauthorize: body.reauthorize !== false, code: body.code || null, hint: body.hint || null, deviceId: creds.deviceId, localStandDown };
    }
    return { have: true, unreachable: true, status: r.status, deviceId: creds.deviceId, localStandDown };
  } catch (e) {
    // A local stand-down marker is evidence the SERVER already refused this credential, recorded
    // when we could still reach it. Trust it when the network is down now.
    if (localStandDown) return { have: true, ok: false, reauthorize: true, code: 'LOCAL_STAND_DOWN', deviceId: creds.deviceId, localStandDown };
    return { have: true, unreachable: true, error: e.message, deviceId: creds.deviceId, localStandDown };
  }
}

/**
 * Retire the local identity so the next agent start enrols a NEW one.
 *
 * Archived rather than deleted: the old device id is the only way to correlate this machine with
 * its history in the admin audit log, and a support question six weeks later is much easier to
 * answer with the file still on disk. It is inert either way — the agent only ever loads
 * `agent-device.json`.
 *
 * The stand-down marker goes too. That is the whole point of a reinstall: it is the one action
 * that legitimately un-retires a machine, because a NEW identity is about to be authorized by a
 * human. The revoked row on the server stays revoked — nothing here un-revokes anything.
 */
function archiveIdentity(reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let archived = null;
  try {
    if (fs.existsSync(CREDS_FILE)) {
      archived = path.join(CREDS_DIR, 'agent-device.retired-' + stamp + '.json');
      fs.renameSync(CREDS_FILE, archived);
    }
  } catch (e) {
    // If it cannot be renamed it MUST still go, or the agent will pick the dead credential up again.
    try { fs.unlinkSync(CREDS_FILE); archived = '(deleted)'; } catch (_) {}
  }
  try { if (fs.existsSync(STAND_DOWN_FILE)) fs.unlinkSync(STAND_DOWN_FILE); } catch (_) {}
  log('retired the local identity (' + (reason || 'credential rejected') + '); archived:', archived || 'none');
  return archived;
}

/** Tell the server this machine is gone, while we still hold the credential to prove it. */
async function reportUninstallToServer() {
  const creds = readCreds();
  if (!creds || !creds.deviceId || !creds.deviceKey) return { reported: false, reason: 'no local credential' };
  try {
    const r = await fetch(apiUrl('uninstall'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': creds.deviceId, 'x-agent-key': creds.deviceKey },
      body: JSON.stringify({ reason: 'agent_uninstalled' }),
      signal: AbortSignal.timeout(15000),
    });
    let body = null; try { body = await r.json(); } catch (_) {}
    return { reported: !!(body && body.ok), status: r.status, body };
  } catch (e) { return { reported: false, error: e.message }; }
}

/** Delete a file or a whole directory, best effort. Never throws. */
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); return true; }
  catch (_) { return false; }
}

/** Remove the Add/Remove Programs entry and the Start-Menu uninstall shortcut. */
function removeUninstallEntry() {
  try { spawnSync('reg', ['delete', UNINSTALL_REG_KEY, '/f'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }); } catch (_) {}
  try { fs.unlinkSync(UNINSTALL_LNK()); } catch (_) {}
}

/**
 * A running exe cannot delete itself on Windows. So the last act of an uninstall is to hand the
 * deletion to a detached `cmd` that waits for this process to exit and then removes the install
 * directory. Without this the uninstall leaves ~91 MB and, more importantly, a WriteHumanAgent.exe
 * that still looks installed.
 */
function scheduleSelfDelete() {
  try {
    // Written to a temp .cmd and launched, rather than passed inline as `cmd /c "<script>"`.
    // Inline was tried first and silently did nothing: the command contains a quoted path, and
    // cmd.exe's /c quote handling strips the outer quotes of the whole string, so the rmdir
    // received a mangled argument and failed with no error anybody would ever see. The observable
    // result was an "uninstall complete" message with a 91 MB exe still sitting on disk.
    //
    // The retry loop matters too: Windows can hold the image of a just-exited process briefly, and
    // one attempt at t+3s is a coin flip. Five attempts over ~15s is not.
    const bat = path.join(os.tmpdir(), 'wh-uninstall-' + process.pid + '.cmd');
    const lines = [
      '@echo off',
      'setlocal',
      'set TARGET=' + INSTALL_DIR,
      'for /L %%i in (1,1,5) do (',
      '  timeout /t 3 /nobreak >nul 2>&1',
      '  rmdir /s /q "%TARGET%" >nul 2>&1',
      '  if not exist "%TARGET%" goto done',
      ')',
      ':done',
      'del /f /q "%~f0" >nul 2>&1',
      '',
    ].join('\r\n');
    fs.writeFileSync(bat, lines, { encoding: 'ascii' });
    spawn('cmd', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() }).unref();
    return true;
  } catch (e) { log('self-delete could not be scheduled:', e.message); return false; }
}

/**
 * The real uninstall.
 *
 * Order matters and is the whole design: tell the server FIRST (while the credential still exists
 * and can prove who we are), then stop the agent, then remove local state, then schedule the
 * directory removal. Doing it the other way round is how a "successful" uninstall leaves a live
 * device row on the server that nothing will ever come back to close.
 *
 * What it deliberately does NOT touch:
 *   - the dedicated WriteHuman Chrome PROFILE. It holds the operator's login. Removing it by
 *     default would silently sign them out of WriteHuman on that machine, which is a much bigger
 *     action than "remove the sync agent". It is offered as an explicit choice.
 *   - the stored session on the server. Uninstalling software does not sign anyone out.
 */
async function doUninstall(opts) {
  const o = opts || {};
  const steps = [];

  const server = await reportUninstallToServer();
  // Three distinct outcomes, said as three distinct sentences. Collapsing them into "device marked
  // UNINSTALLED" reads as a successful write even when the server had already retired this row (or
  // never knew it), and during an incident that is the difference between "done" and "check it".
  steps.push('server: ' + (
    server.reported && server.body && server.body.alreadyRetired
      ? 'device was already retired server-side (' + server.body.code + '); nothing further to close'
      : server.reported
        ? 'device marked UNINSTALLED' + (server.body && server.body.activeSourceCleared ? ' (active source cleared, nothing auto-selected)' : '')
        : 'NOT reported (' + (server.reason || server.error || ('HTTP ' + server.status)) + ') — revoke this device in the admin panel'
  ));

  stopRunningAgent();
  steps.push('agent: stopped');

  removeAutoStart();
  removeUninstallEntry();
  for (const lnk of [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WriteHuman Chrome.lnk'),
    path.join(os.homedir(), 'Desktop', 'WriteHuman Chrome.lnk'),
  ]) { try { fs.unlinkSync(lnk); } catch (_) {} }
  steps.push('startup + shortcuts: removed');

  // The credential and the identity go even if the directory removal is later blocked, so a
  // half-finished uninstall can never leave a machine able to authenticate.
  for (const f of [CREDS_FILE, STAND_DOWN_FILE, CONFIG_FILE, LOCK_FILE, INSTALLED_MARKER]) rmrf(f);
  rmrf(CREDS_DIR);
  steps.push('config, identity and credential: removed');

  if (o.removeChromeProfile) {
    killOurStrayChrome();
    sleepSync(1500);
    rmrf(CHROME_ROOT);
    steps.push('WriteHuman Chrome profile: removed (you will need to sign in again next time)');
  } else {
    steps.push('WriteHuman Chrome profile: KEPT at ' + CHROME_ROOT);
  }

  const scheduled = scheduleSelfDelete();
  steps.push('program files: ' + (scheduled ? 'removed after exit' : 'left at ' + INSTALL_DIR + ' (remove by hand)'));

  log('uninstall complete:\n  - ' + steps.join('\n  - '));
  return { ok: true, steps, server };
}

const UNINSTALL_LNK = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Uninstall WriteHuman Agent.lnk');

/**
 * Make the agent uninstallable the two ways a Windows user actually looks: Settings ▸ Apps, and
 * the Start Menu. Neither existed, so the only route was a command line with a flag nobody knew —
 * which on a locked-down RDP is indistinguishable from "cannot be uninstalled".
 */
function registerUninstallEntry() {
  const reg = (name, type, value) => {
    try {
      spawnSync('reg', ['add', UNINSTALL_REG_KEY, '/v', name, '/t', type, '/d', String(value), '/f'],
        { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    } catch (_) {}
  };
  reg('DisplayName', 'REG_SZ', DISPLAY_NAME);
  reg('DisplayVersion', 'REG_SZ', selfAgentVersion() || '0.0.0');
  reg('Publisher', 'REG_SZ', 'Gen Z Digital Store');
  reg('InstallLocation', 'REG_SZ', INSTALL_DIR);
  reg('UninstallString', 'REG_SZ', '"' + INSTALLED_EXE + '" --uninstall');
  reg('QuietUninstallString', 'REG_SZ', '"' + INSTALLED_EXE + '" --uninstall --silent');
  reg('DisplayIcon', 'REG_SZ', INSTALLED_EXE);
  reg('NoModify', 'REG_DWORD', 1);
  reg('NoRepair', 'REG_DWORD', 0);
  reg('EstimatedSize', 'REG_DWORD', 90000);

  const ps = [
    '$w = New-Object -ComObject WScript.Shell;',
    '$s = $w.CreateShortcut(' + JSON.stringify(UNINSTALL_LNK()) + ');',
    '$s.TargetPath = ' + JSON.stringify(INSTALLED_EXE) + ';',
    "$s.Arguments = '--uninstall';",
    '$s.WorkingDirectory = ' + JSON.stringify(INSTALL_DIR) + ';',
    '$s.Description = ' + JSON.stringify('Remove the WriteHuman Agent from this computer') + ';',
    '$s.Save();',
  ].join(' ');
  try { spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 15000 }); } catch (_) {}
}

const STARTUP_LNK = () => {
  const startup = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return path.join(startup, 'WriteHuman Agent.lnk');
};

/**
 * Auto-start at logon, no administrator rights.
 *
 * A scheduled task would be nicer (it can restart-on-failure), but Task Scheduler is frequently
 * locked down by policy on managed and RDP machines - it is denied outright here, both via
 * schtasks.exe and the PowerShell cmdlet. The Startup-folder shortcut is the mechanism that ALWAYS
 * works for a per-user install: it needs no privileges at all and runs at every logon.
 *
 * The shortcut is created minimized (WindowStyle 7) so no console flashes on the user's screen, and
 * it points at the installed exe with --agent. Made through powershell's COM (WScript.Shell) because
 * a .lnk is a binary shell format; powershell.exe is always present, and the USER never types it.
 */
function registerAutoStart() {
  const lnk = STARTUP_LNK();
  const ps = [
    "$w = New-Object -ComObject WScript.Shell;",
    "$s = $w.CreateShortcut(" + JSON.stringify(lnk) + ");",
    "$s.TargetPath = " + JSON.stringify(INSTALLED_EXE) + ";",
    "$s.Arguments = '--agent';",
    "$s.WorkingDirectory = " + JSON.stringify(INSTALL_DIR) + ";",
    "$s.WindowStyle = 7;",
    "$s.Description = 'WriteHuman Universal Agent';",
    "$s.Save();",
  ].join(' ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
  return r.status === 0 && fs.existsSync(lnk);
}
function removeAutoStart() { try { fs.unlinkSync(STARTUP_LNK()); } catch (_) {} }

// ── Visible installer UX ─────────────────────────────────────────────────────
// A one-click installer must never just flash a console and vanish. The console the OS gives a
// double-clicked exe closes the instant we exit, so the RELIABLE way to leave something on screen
// is a native Windows dialog. This shows one via PowerShell + WinForms (present on every Win10/11,
// no admin, no extra files) and blocks until the user clicks, so the result is always seen. The
// script is passed as an -EncodedCommand (UTF-16LE base64) so message text needs no quoting.
// Standardized exit codes so an installing tool/log can tell outcomes apart.
const EXIT = { SUCCESS: 0, ALREADY: 10, REPAIRED: 11, PKG_INVALID: 20, FILE_FAILED: 21, AUTOSTART_FAILED: 22, AGENT_FAILED: 23, ENROL_PENDING: 24, CHROME_FAILED: 25 };

function messageBox(message, title, buttons /* OK|OKCancel|YesNo|YesNoCancel|RetryCancel */, icon /* Information|Error|Warning|Question */) {
  // Unattended/silent mode (WHV2_SILENT=1): no dialog, install still completes end-to-end. Used for
  // automated tests and scripted mass deployment. Interactive double-click keeps the visible dialog.
  if (process.env.WHV2_SILENT === '1') { try { log('[dialog:silent]', title, '::', String(message).replace(/\n+/g, ' | ')); } catch (_) {} return ''; }
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$r=[System.Windows.Forms.MessageBox]::Show(' + lit(message) + ',' + lit(title) +
      ',[System.Windows.Forms.MessageBoxButtons]::' + buttons +
      ',[System.Windows.Forms.MessageBoxIcon]::' + (icon || 'Information') + ')',
    '[Console]::Out.Write($r.ToString())',
  ].join('\n');
  try {
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true, timeout: 5 * 60000 });
    return (r.stdout || '').trim();  // 'OK' | 'Cancel' | 'Yes' | 'No' | 'Retry'
  } catch (_) { return ''; }
}

/** Is a healthy agent already running? Fresh singleton lock (<10 min) whose PID is alive. */
function isAgentRunning() {
  try {
    const lk = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'agent.lock'), 'utf8'));
    if (!lk || !lk.pid) return false;
    const fresh = lk.at && (Date.now() - new Date(lk.at).getTime()) < 10 * 60000;
    if (!fresh) return false;
    try { process.kill(lk.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  } catch (_) { return false; }
}

/**
 * Stop a running installed agent so its exe can be replaced (a running exe is locked on Windows).
 * Kills ONLY our installed image — the installer itself runs from a different filename
 * (WriteHuman-Agent-Setup-*.exe), and the dedicated Chrome is a separate process, so neither is
 * touched. The server keeps serving the last verified bundle while the agent is briefly down; the
 * 'Starting Agent' stage brings it back with the SAME device identity (creds are never removed).
 */
function stopRunningAgent() {
  try { const lk = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'agent.lock'), 'utf8')); if (lk && lk.pid) { try { process.kill(lk.pid); } catch (_) {} } } catch (_) {}
  try { spawnSync('taskkill', ['/f', '/im', 'WriteHumanAgent.exe'], { windowsHide: true, timeout: 15000 }); } catch (_) {}
}

/**
 * Synchronous sleep with NO child process. Critical inside the SEA: `process.execPath` is the SEA
 * exe itself, not node — spawning it to "sleep" would ignore any `-e` and re-run this installer
 * recursively. Atomics.wait blocks the thread for `ms` without launching anything.
 */
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); } catch (_) {} }

/** Copy with a few retries: after stopping the agent, Windows can take a moment to release the handle. */
function copyWithRetry(src, dst) {
  let lastErr = null;
  for (let i = 0; i < 10; i++) {
    try { fs.copyFileSync(src, dst); return; }
    catch (e) { lastErr = e; sleepSync(500); }
  }
  throw lastErr || new Error('copy failed');
}

/**
 * Is the installed copy the SAME BUILD as this installer?
 *
 * This used to compare file SIZE. A SEA exe is ~91 MB of node runtime plus a few KB of embedded
 * agent, so two different agent versions can easily land on the same byte count - and when they do,
 * re-running the installer reports "already installed and running" and refuses to upgrade. That is
 * a silent no-op upgrade: the operator sees success and keeps running the old agent. Compare the
 * VERSION the exe actually carries instead.
 *
 * An install with no marker (written by an older installer) is treated as NOT current, so the first
 * run of a new installer always upgrades rather than assuming.
 */
function installedSameBuild() {
  try {
    if (!fs.existsSync(INSTALLED_EXE)) return false;
    const mine = selfAgentVersion();
    const theirs = installedAgentVersion();
    if (!mine || !theirs) return false;
    return mine === theirs;
  } catch (_) { return false; }
}

/**
 * Run the ordered install stages, printing each to the console (for terminal runs) and stopping at
 * the first failure with its own exit code. Returns { ok, code, stage, error }.
 */
function runStages(isRepair) {
  const stages = [
    ['Verifying installer', () => {
      // The exe IS the package (SEA). Confirm the bundled agent asset is present and non-trivial.
      const src = agentSource();
      if (!src || src.length < 500) { const e = new Error('bundled agent asset missing'); e.exit = EXIT.PKG_INVALID; throw e; }
    }],
    ['Installing WriteHuman Agent', () => {
      try {
        ensureDirs();
        if (path.resolve(selfPath()).toLowerCase() !== path.resolve(INSTALLED_EXE).toLowerCase()) {
          // Update/repair: a running agent locks its own exe, so stop it before replacing, then
          // copy with retries while the handle releases. Fresh install: nothing to stop.
          if (fs.existsSync(INSTALLED_EXE)) stopRunningAgent();
          copyWithRetry(selfPath(), INSTALLED_EXE);
        }
        writeDefaultConfig();   // preserves an existing config + device identity (early-returns if present)
        writeInstalledMarker();  // records the agent version just installed, for upgrade detection
      } catch (e) { e.exit = EXIT.FILE_FAILED; throw e; }
    }],
    ['Registering auto-start', () => {
      // Non-fatal: a machine where the Startup folder is locked can still run now; we only warn.
      const ok = registerAutoStart();
      if (!ok) log('auto-start could not be set (Startup folder locked?) - the agent runs now but will not auto-start.');
      // Also non-fatal, and the reason an RDP could not be cleaned up before: without this the
      // agent appears in neither Settings ▸ Apps nor the Start Menu, so the only uninstall route
      // was an undocumented command-line flag.
      registerUninstallEntry();
    }],
    ['Opening WriteHuman Chrome', () => {
      try {
        fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
        createChromeShortcuts();
      } catch (e) { e.exit = EXIT.CHROME_FAILED; throw e; }
      launchChrome().catch(() => {});   // idempotent; no-op if CDP already up
    }],
    ['Starting Agent', () => {
      try {
        const child = spawn(INSTALLED_EXE, ['--agent'], { detached: true, stdio: 'ignore', cwd: INSTALL_DIR });
        child.unref();
      } catch (e) { e.exit = EXIT.AGENT_FAILED; throw e; }
    }],
  ];
  for (const [name, fn] of stages) {
    log((isRepair ? 'repair: ' : '') + name + '…');
    try { fn(); }
    catch (e) { return { ok: false, code: e.exit || EXIT.FILE_FAILED, stage: name, error: e.message }; }
  }
  return { ok: true, code: isRepair ? EXIT.REPAIRED : EXIT.SUCCESS, stage: null, error: null };
}

/** Confirm the agent process actually came up within a short window (visible pending vs. failed). */
function waitForAgent(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  while (Date.now() < deadline) {
    if (isAgentRunning()) return true;
    sleepSync(750);   // real sleep, no child process (see sleepSync)
  }
  return isAgentRunning();
}

/**
 * Decide what KIND of install this is, and say so out loud.
 *
 * The four cases are genuinely different and used to be collapsed into two ("is the exe there?"),
 * which is what made case B — a local credential the server has rejected — silently take the
 * "repair" path and hand the agent its dead credential back.
 *
 *   A  healthy + current           already installed → offer Chrome / Repair / Uninstall
 *   B  credential REJECTED         retire the identity, install, and let the agent open a FRESH
 *                                  browser authorization for a NEW device id
 *   C  damaged or out of date      repair the files, KEEP a valid identity
 *   D  nothing here                fresh install
 */
async function runInstaller() {
  const fresh = !fs.existsSync(INSTALLED_EXE);
  const probe = fresh ? { have: false } : await probeCredential();

  // B. The server has rejected this machine's credential (revoked, uninstalled, superseded, or it
  //    no longer recognises it). Repairing in place would reinstate the dead credential — the exact
  //    bug. Retire the identity so the agent starts a fresh PKCE browser authorization instead.
  if (probe.have && probe.ok === false && probe.reauthorize) {
    log('this machine’s credential was rejected by the server (' + (probe.code || 'unknown') + ') — starting a fresh authorization');
    const choice = messageBox(
      'This computer’s WriteHuman Agent registration is no longer valid.\n\n' +
      'Reason: ' + (probe.code || 'credential rejected') + '\n\n' +
      (probe.hint || 'The device was revoked, uninstalled or replaced.') + '\n\n' +
      'Continuing will install the agent and start a NEW authorization: an admin approves it once in\n' +
      'the browser, and this computer gets a brand-new identity. The old one is not reused.\n\n' +
      'OK → Reinstall and re-authorize      Cancel → Close',
      'WriteHuman Agent — re-authorization needed', 'OKCancel', 'Warning');
    if (choice === 'Cancel') process.exit(EXIT.ALREADY);
    stopRunningAgent();
    archiveIdentity(probe.code || 'credential rejected');
    return finishInstall(false, { reauthorized: true });
  }

  // A. Healthy, current, and running. Do not reinstall or spawn a duplicate — offer the choices,
  //    Uninstall now among them.
  const healthy = !fresh && probe.ok !== false && isAgentRunning() && installedSameBuild();
  if (healthy) {
    log('WriteHuman Agent is already installed and running.' + (probe.state ? ' Server state: ' + probe.state : ''));
    const r = messageBox(
      'WriteHuman Agent is already installed and running.\n' +
      (probe.state ? '\nThis computer is currently: ' + probe.state + '\n' : '') +
      '\nYes  →  Open WriteHuman Chrome\n' +
      'No   →  Repair installation\n' +
      'Cancel →  Uninstall or close',
      'WriteHuman Agent', 'YesNoCancel', 'Information');
    if (r === 'Yes') { launchChrome().catch(() => {}); process.exit(EXIT.ALREADY); }
    if (r === 'No') return finishInstall(true);
    // Cancel is the "anything else" branch, and the only place an operator can reach Uninstall from
    // a double-click. It asks again before doing anything destructive.
    const u = messageBox(
      'Remove WriteHuman Agent from this computer?\n\n' +
      'Yes → Uninstall\n' +
      'No  → Close and leave it running',
      'WriteHuman Agent', 'YesNo', 'Question');
    if (u === 'Yes') return interactiveUninstall();
    process.exit(EXIT.ALREADY);
  }

  // C / D. A damaged, outdated or absent installation, with an identity that is either valid or
  //        not there at all. Repair or install; `writeDefaultConfig` and the creds file are both
  //        preserved, so a valid enrolment survives.
  if (probe.unreachable) log('could not reach the server to check this machine’s registration — keeping the existing identity');
  return finishInstall(!fresh);
}

/** Uninstall with the one question that genuinely needs asking, then a truthful summary. */
async function interactiveUninstall() {
  const keep = messageBox(
    'Also remove WriteHuman Chrome profile data?\n\n' +
    'This profile holds your WriteHuman login on this computer.\n\n' +
    'No  → Keep it (recommended). You stay signed in.\n' +
    'Yes → Delete it. You will have to sign in to WriteHuman again here.',
    'WriteHuman Agent — Uninstall', 'YesNo', 'Question');
  const res = await doUninstall({ removeChromeProfile: keep === 'Yes' });
  messageBox(
    'WriteHuman Agent has been removed from this computer.\n\n' +
    res.steps.map(s => '• ' + s).join('\n') + '\n\n' +
    'The WriteHuman session stored on the server is unchanged, and no other computer was\n' +
    'automatically made the active source.',
    'WriteHuman Agent — Uninstalled', 'OK', 'Information');
  process.exit(EXIT.SUCCESS);
}

function finishInstall(isRepair, opts) {
  const o = opts || {};
  const res = runStages(isRepair);
  if (!res.ok) {
    const codeName = Object.keys(EXIT).find(k => EXIT[k] === res.code) || 'FILE_FAILED';
    log('installation FAILED at:', res.stage, '-', res.error, '(exit', res.code + ')');
    messageBox(
      'Installation failed while: ' + res.stage + '.\n\n' +
      'Error code: ' + codeName + '\n' +
      'Log: ' + path.join(INSTALL_DIR, 'logs', 'agent.log') + '\n\n' +
      'Double-click the installer again to retry or repair.',
      'WriteHuman Agent — Installation failed', 'OK', 'Error');
    process.exit(res.code);
  }

  // Success path: confirm the agent actually started so we show a truthful message. A cold SEA
  // (~90 MB) plus first enrolment/CDP handshake can take >12s, so give it a real window.
  const up = waitForAgent(30000);
  log('installation complete. agent', up ? 'running' : 'starting (pending)');
  const statusLine = up ? 'Agent status: Running' : 'Agent status: Starting…';
  const pendingNote = o.reauthorized
    // After a re-authorization the very next thing that happens is a browser page an admin must
    // approve. Saying so is the difference between "it worked" and an operator sitting in front of
    // an agent that is waiting for a click nobody knows about.
    ? 'This computer is requesting a NEW authorization. A browser page has been opened for an admin\n' +
      'to approve it — the agent starts syncing a few seconds after that approval. Nothing from the\n' +
      'old, rejected registration is reused.'
    : (up
      ? 'Sign in to WriteHuman in the "WriteHuman Chrome" window — cookie sync is then automatic.'
      : 'The agent is starting and finishes one-time authorization in the background. If it does not come online shortly, double-click the installer again to repair.');
  const r = messageBox(
    'WriteHuman Agent installed successfully.\n\n' +
    statusLine + '\nWriteHuman Chrome: Ready\n\n' + pendingNote + '\n\n' +
    'This computer does NOT become the active WriteHuman source on its own. An admin presses\n' +
    'Mark Active for it in the dashboard when they want the session to move here.\n\n' +
    'Yes → Open WriteHuman Chrome now      No → Close',
    'WriteHuman Agent — ' + (o.reauthorized ? 'Re-authorizing' : (isRepair ? 'Repair complete' : 'Installed')), 'YesNo', 'Information');
  if (r === 'Yes') launchChrome().catch(() => {});
  process.exit(up ? res.code : EXIT.ENROL_PENDING);
}

function main() {
  const args = process.argv.slice(2).map(a => String(a).toLowerCase());
  const arg = args[0] || '';

  if (arg === '--uninstall') {
    // Silent/scripted uninstall (also what QuietUninstallString in Add/Remove Programs invokes),
    // or the interactive one that asks the single question worth asking.
    const silent = args.includes('--silent') || process.env.WHV2_SILENT === '1';
    const purge = args.includes('--purge-chrome-profile');
    if (silent) {
      doUninstall({ removeChromeProfile: purge })
        .then(() => process.exit(EXIT.SUCCESS))
        .catch((e) => { log('uninstall failed:', e.message); process.exit(EXIT.FILE_FAILED); });
    } else {
      interactiveUninstall().catch((e) => { log('uninstall failed:', e.message); process.exit(EXIT.FILE_FAILED); });
    }
    return;
  }
  if (arg === '--launch-chrome') { launchChrome().then(ok => process.exit(ok ? 0 : 1)); return; }
  if (arg === '--status') {
    // Read-only diagnosis, for support: what does the SERVER think this machine is?
    probeCredential().then((p) => {
      log('install dir:', INSTALL_DIR);
      log('installed agent version:', installedAgentVersion() || 'none');
      log('local credential:', p.have ? (p.deviceId || 'present') : 'none');
      log('stand-down marker:', p.localStandDown ? 'PRESENT (this installation is dormant)' : 'none');
      log('server verdict:', p.ok ? p.state : (p.unreachable ? 'unreachable' : (p.code || 'rejected')));
      process.exit(0);
    }).catch(() => process.exit(1));
    return;
  }
  if (arg === '--agent' || alreadyInstalledAndCurrent()) { runAgent(); return; }
  runInstaller().catch((e) => {
    log('installer failed:', e && e.message);
    messageBox('Installation could not start: ' + (e && e.message) + '\n\nDouble-click the installer again to retry.',
      'WriteHuman Agent — Installation failed', 'OK', 'Error');
    process.exit(EXIT.FILE_FAILED);
  });
}

main();
