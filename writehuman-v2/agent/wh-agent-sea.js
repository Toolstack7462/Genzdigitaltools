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

// SEA runtime handle (present only inside the built exe; absent when run as a plain script in dev).
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea || !sea.isSea()) sea = null; } catch (_) { sea = null; }

function log(...a) { try { console.log('[wh-setup]', ...a); } catch (_) {} }

/** The agent source: from the bundled asset in the exe, else the sibling file in dev. */
function agentSource() {
  if (sea) return sea.getAsset(AGENT_ASSET, 'utf8');
  return fs.readFileSync(path.join(__dirname, AGENT_ASSET), 'utf8');
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

function alreadyInstalledAndCurrent() {
  try {
    if (!fs.existsSync(INSTALLED_EXE)) return false;
    // Same bytes? then this IS the installed copy (agent mode) or a re-run of the same version.
    const a = fs.statSync(selfPath()).size, b = fs.statSync(INSTALLED_EXE).size;
    return a === b && path.resolve(selfPath()).toLowerCase() === path.resolve(INSTALLED_EXE).toLowerCase();
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

function install() {
  log('installing to', INSTALL_DIR);
  ensureDirs();
  // Copy the running exe into place. If it is already there (double-clicked from the install dir),
  // this is a no-op we skip so we do not copy a file onto itself.
  if (path.resolve(selfPath()).toLowerCase() !== path.resolve(INSTALLED_EXE).toLowerCase()) {
    fs.copyFileSync(selfPath(), INSTALLED_EXE);
  }
  writeDefaultConfig();
  const ok = registerAutoStart();
  log('auto-start at logon', ok ? 'enabled (Startup shortcut)' : 'could not be set - the agent runs now but will not auto-start; re-run the installer');

  // Dedicated WriteHuman Chrome: make its profile dir + the shortcuts, and open it once so the user
  // lands on a logged-out writehuman.ai ready to sign in. This never touches everyday Chrome.
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  createChromeShortcuts();
  log('created "WriteHuman Chrome" shortcut (Start Menu + Desktop)');
  launchChrome().catch(() => {});

  // Launch the installed connector detached; it enrols and starts monitoring the dedicated profile.
  const child = spawn(INSTALLED_EXE, ['--agent'], { detached: true, stdio: 'ignore', cwd: INSTALL_DIR });
  child.unref();
  log('connector started. A browser page opens for one-time authorization.');
  log('after authorizing: sign in to WriteHuman in the "WriteHuman Chrome" window — sync is then automatic.');
}

function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  if (arg === '--uninstall') {
    removeAutoStart();
    for (const lnk of [
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WriteHuman Chrome.lnk'),
      path.join(os.homedir(), 'Desktop', 'WriteHuman Chrome.lnk'),
    ]) { try { fs.unlinkSync(lnk); } catch (_) {} }
    log('auto-start + shortcuts removed. Program files remain at', INSTALL_DIR);
    log('the dedicated WriteHuman Chrome profile is KEPT (it holds your login); delete', CHROME_ROOT, 'to remove it.');
    log('the stored WriteHuman session on the server is NOT affected. Revoke this device in the admin panel if desired.');
    return;
  }
  if (arg === '--launch-chrome') { launchChrome().then(ok => process.exit(ok ? 0 : 1)); return; }
  if (arg === '--agent' || alreadyInstalledAndCurrent()) { runAgent(); return; }
  install();
}

main();
