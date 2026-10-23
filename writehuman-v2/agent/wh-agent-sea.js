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
const crypto = require('crypto');
// NOTE: there is deliberately no BUILD_ID constant here. It used to be hardcoded ('3.5.15-retry-rc1')
// and went stale the moment the agent asset moved to 3.5.16, which is half of why that installer
// could not start. The build identity now comes from the embedded asset via selfBuildId(), so there
// is exactly ONE place a release version is written: cookie-sync-agent.js. It cannot be a const at
// this point in the file because `sea` is not initialised until further down.

const APP_DIR_NAME = path.join('GenZDigitalTools', 'WriteHumanAgent');
// Installed modes must survive logon without the installer's shell overrides.
const EXECUTABLE_INSTALL_DIR=path.basename(String(process.execPath||'')).toLowerCase()==='writehumanagent.exe'?path.dirname(process.execPath):null;
const INSTALL_DIR = process.env.WHV2_INSTALL_DIR || (process.env.WHV2_CONFIG ? path.dirname(path.resolve(process.env.WHV2_CONFIG)) :
  EXECUTABLE_INSTALL_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_DIR_NAME));
const INSTALLED_EXE = path.join(INSTALL_DIR, 'WriteHumanAgent.exe');
const TASK_NAME = 'WriteHumanUniversalAgent';
const AGENT_ASSET = 'cookie-sync-agent.js';

// Everything an install OWNS, named once so the uninstaller cannot miss a piece. The previous
// `--uninstall` removed three shortcuts and left every one of these behind — the running agent
// included, still holding a live credential and still auto-starting at the next logon.
const CREDS_DIR = path.join(INSTALL_DIR, 'creds');
const CREDS_FILE = path.join(CREDS_DIR, 'agent-device.json');
const STAND_DOWN_FILE = path.join(CREDS_DIR, 'stood-down.json');
function installedConfigPath(){
  try{const m=JSON.parse(fs.readFileSync(path.join(INSTALL_DIR,'installed.json'),'utf8'));
    if(typeof m.configPath==='string'&&path.isAbsolute(m.configPath)&&/\.json$/i.test(m.configPath))return m.configPath;
    const name=typeof m.configName==='string'&&/^[^\\/]+\.json$/i.test(m.configName)?m.configName:'config.json';
    return path.join(INSTALL_DIR,name);
  }catch(_){return path.join(INSTALL_DIR,'config.json');}
}
const CONFIG_FILE = process.env.WHV2_CONFIG || installedConfigPath();

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
/**
 * The build identity carried INSIDE this exe, read from the same bundled asset as the version.
 *
 * Derived, never hardcoded. The previous hardcoded BUILD_ID described 3.5.15 while the asset said
 * 3.5.16, so the installer reported a build it was not and `installedSameBuild()` could never match.
 */
function selfBuildId() {
  try { return (agentSource().match(/AGENT_BUILD_ID\s*=\s*'([^']+)'/) || [])[1] || null; }
  catch (_) { return null; }
}
/** The version recorded by whichever installer last wrote INSTALLED_EXE. */
function installedAgentVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'installed.json'), 'utf8').replace(/^\uFEFF/, '')).agentVersion || null; }
  catch (_) { return null; }
}
/** Stamp what we just installed, so the next run can compare versions instead of guessing. */
function writeInstalledMarker() {
  const value = { agentVersion: selfAgentVersion(), buildId: selfBuildId(),
    configName:path.basename(CONFIG_FILE),
    ...(path.resolve(path.dirname(CONFIG_FILE)).toLowerCase()!==path.resolve(INSTALL_DIR).toLowerCase()?{configPath:path.resolve(CONFIG_FILE)}:{}),
    sourceSha256: sha256(agentSource()), executableSha256: sha256(fs.readFileSync(INSTALLED_EXE)),
    installedAt: new Date().toISOString() };
  const temp = INSTALLED_MARKER + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), {encoding:'utf8', mode:0o600});
  fs.renameSync(temp, INSTALLED_MARKER);
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function psLiteral(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function readJsonStrict(file) { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); }
function validatePackage() {
  const source = agentSource();
  if (!source || source.length < 500) throw new Error('Invalid embedded Agent package.');
  // WHY THIS IS NOT A LITERAL ANY MORE.
  //
  // This read `selfAgentVersion() !== '3.5.15'`. The asset moved to 3.5.16, the literal did not, and
  // the installer rejected its OWN payload with "Invalid embedded Agent package." before doing
  // anything — including for `--package-info`. A pinned expected version is a constant that must be
  // edited in lockstep with every release, which is exactly the class of bug that produced it.
  //
  // The replacement is a STRONGER invariant, not a looser one: the package must state a well-formed
  // semver version AND a build identity that belongs to that version. Arbitrary content still
  // fails (no AGENT_VERSION -> null -> throw), a malformed version fails, and a version/build-id
  // pair that disagree with each other fails — which the old single-literal check never detected.
  const version = selfAgentVersion();
  const buildId = selfBuildId();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid embedded Agent package.');
  if (!buildId || !buildId.startsWith(version + '-')) throw new Error('Invalid embedded Agent package.');
  new (require('vm').Script)(source, {filename:'embedded-cookie-sync-agent.js'});
  let buildMethod=sea?'unknown':'source-only';
  if(sea){
    try{
      const method=JSON.parse(sea.getAsset('build-manifest.json','utf8')).buildMethod;
      if(['cross-platform','windows-native'].includes(method))buildMethod=method;
    }catch(_){}
  }
  return {product:'WriteHuman Agent',version:selfAgentVersion(),buildId:selfBuildId(),
    sourceSha256:sha256(source),nodeVersion:process.version,platform:process.platform,arch:process.arch,
    packaging:sea?'windows-node-sea':'source-only',buildMethod,recoveryOffByDefault:true};
}
function compareVersion(a,b) {
  const parse=v=>{ if(!/^\d+\.\d+\.\d+$/.test(String(v)))throw new Error('Invalid Agent version metadata.');return v.split('.').map(Number); };
  const x=parse(a),y=parse(b);
  for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i]?1:-1;}return 0;
}
function validateUpgrade() {
  validatePackage();
  if (fs.existsSync(INSTALLED_EXE)) {
    if (!fs.existsSync(CONFIG_FILE)) throw new Error('Existing Agent configuration is missing. No running Agent was changed.');
    const cfg=readJsonStrict(CONFIG_FILE);
    if (!cfg || typeof cfg!=='object' || Array.isArray(cfg)) throw new Error('Existing configuration is invalid.');
    const version=installedAgentVersion();
    if(version && compareVersion(version,selfAgentVersion())>0) throw new Error('Refusing to downgrade a newer Agent.');
  }
}

// Back up before stopping anything. Access control failure stops the upgrade.
function backupInstallation() {
  if (!fs.existsSync(INSTALLED_EXE)) return null;
  const root=path.join(path.dirname(INSTALL_DIR),'AgentBackups');
  fs.mkdirSync(root,{recursive:true});
  const dir=fs.mkdtempSync(path.join(root,selfAgentVersion()+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'));
  const cmd="$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;"+
    "& icacls.exe "+psLiteral(dir)+" '/inheritance:r' '/grant:r' (('*'+$sid)+':(OI)(CI)F') | Out-Null;"+
    "if($LASTEXITCODE -ne 0){exit 1}";
  const secured=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{stdio:'ignore',windowsHide:true,timeout:15000});
  if(secured.status!==0) throw new Error('Could not secure the local backup. Upgrade cancelled.');
  const files=[];
  const paths=effectiveStatePaths();
  const entries=[['WriteHumanAgent.exe',INSTALLED_EXE],[path.basename(CONFIG_FILE),CONFIG_FILE],['installed.json',INSTALLED_MARKER],
    ['private/device.json',paths.device],['private/stand-down.json',paths.standDown],
    ['private/recovery.json',paths.recovery],['private/source-credential.dpapi',paths.vault]];
  for(const [backup,source] of entries){
    if(!fs.existsSync(source))continue;
    const destination=path.join(dir,backup);fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(source,destination);
    const digest=sha256(fs.readFileSync(source));
    if(digest!==sha256(fs.readFileSync(destination)))throw new Error('Backup integrity check failed.');
    files.push({source,backup,sha256:digest});
  }
  // Contents and path mapping stay under the secured local backup ACL. Do not
  // export this manifest or restore state automatically during binary rollback.
  fs.writeFileSync(path.join(dir,'backup-manifest.json'),JSON.stringify({schema:1,files},null,2),{mode:0o600});
  log('Private rollback backup:',dir);
  return dir;
}

/**
 * Tee console output to logs\agent.log. In SEA agent mode there is no run-agent.cmd wrapper to
 * redirect stdout, and the logon shortcut launches the exe detached, so without this the agent's
 * (already timestamped, cookie-value-free) log lines would go nowhere — which is exactly how a
 * silent failure hides. Bounded so it cannot grow without limit.
 */
function logSettings(){
  const cfg=readCfg(),bounded=(value,min,max,fallback)=>Number.isFinite(Number(value))&&Number(value)>=min?Math.min(max,Math.floor(Number(value))):fallback;
  return {maxBytes:bounded(process.env.WHV2_LOG_MAX_BYTES??cfg.logMaxBytes,65536,20*1024*1024,5*1024*1024),
    retainedFiles:bounded(process.env.WHV2_LOG_RETAINED_FILES??cfg.logRetainedFiles,1,10,3)};
}
function attachLogFile() {
  try {
    const logDir = path.join(INSTALL_DIR, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'agent.log');
    const {maxBytes:max,retainedFiles}=logSettings();
    // Synchronous bounded writes avoid unhandled asynchronous stream errors.
    // Logging failures are swallowed; they must never terminate recovery.
    const tee = (orig) => (...args) => {
      try {
        const line=args.map(String).join(' ').slice(0,16384)+'\n';
        if(fs.existsSync(logPath)&&fs.statSync(logPath).size+Buffer.byteLength(line)>max){
          for(let n=retainedFiles;n>=1;n--){
            const dest=logPath+'.'+n,src=n===1?logPath:logPath+'.'+(n-1);
            if(fs.existsSync(dest))fs.unlinkSync(dest);
            if(fs.existsSync(src))fs.renameSync(src,dest);
          }
        }
        fs.appendFileSync(logPath,line,{encoding:'utf8',mode:0o600});
      } catch (_) {}
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
  process.env.WHV2_CONFIG = process.env.WHV2_CONFIG || CONFIG_FILE;
  m._compile(src.replace('if (require.main === module) start();', 'start();'), m.filename);
}

function localReviewAgent(){
  const Module=require('module'),m=new Module(INSTALLED_EXE,null);
  m.filename=path.join(INSTALL_DIR,AGENT_ASSET);m.paths=Module._nodeModulePaths(INSTALL_DIR);
  process.env.WHV2_CONFIG=process.env.WHV2_CONFIG||CONFIG_FILE;
  // Compile without invoking start(): this mode must never enroll, poll, decrypt
  // a vault, access Chrome or submit credentials.
  m._compile(agentSource(),m.filename);
  return m.exports;
}
function acknowledgeRecoveryChallenge(){return localReviewAgent().acknowledgeResolvedChallenge(true);}
function authorizeSessionLimitRecovery(){return localReviewAgent().authorizeSessionLimitRecovery(true);}

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
// launcher. Recovery never kills Chrome or removes profile locks; an unavailable
// debugging port alone is not proof that a process is safe to terminate.
const CHROME_ROOT = path.join(path.dirname(INSTALL_DIR), 'WriteHumanChrome');
const CHROME_PROFILE_DIR = path.join(CHROME_ROOT, 'UserData');
const DEFAULT_CDP_PORT = 9315;   // not Chrome's usual 9222, to avoid colliding with any other tool

function readCfg() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return {}; } }
function cdpPort() {
  // Fresh installs explicitly write 9315. An existing legacy config without
  // cdpUrl uses the Agent's 9222 default; launching on 9315 would never reconnect it.
  const raw=process.env.WHV2_CDP_URL||readCfg().cdpUrl||'http://127.0.0.1:9222';
  const u=new URL(raw);
  if(u.protocol!=='http:'||!['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname)||u.username||u.password)throw new Error('Invalid local CDP URL.');
  return Number(u.port||80);
}
function chromeProfileDir(){return process.env.WHV2_CHROME_PROFILE||readCfg().chromeProfile||CHROME_PROFILE_DIR;}

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

/** Launch once, retaining existing Chrome processes and profile locks. */
async function launchChrome() {
  const port = cdpPort();
  if (await cdpUp(port, 4000)) { log('WriteHuman Chrome already running (CDP up on', port + ')'); return true; }
  const exe = findChromeExe();
  if (!exe) { log('Chrome not found — install Google Chrome, then reopen WriteHuman Chrome'); return false; }
  const profile=chromeProfileDir();
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1',   // bind CDP to loopback only, never public
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-session-crashed-bubble',
    'https://writehuman.ai',
  ];
  // Chrome arbitrates profile ownership. A missing debug port does not authorize
  // killing any process or deleting a lock, even for a dedicated profile.
  try { spawn(exe,args,{detached:true,stdio:'ignore'}).unref(); }
  catch (_) { log('Chrome launch failed'); return false; }
  for(let i=0;i<12;i++){
    await new Promise(r=>setTimeout(r,2000));
    if(await cdpUp(port,3000)){log('WriteHuman Chrome up on',port);return true;}
  }
  log('ERROR: WriteHuman Chrome CDP did not become ready; existing processes and profile locks were retained');
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
      '$s = $w.CreateShortcut(' + psLiteral(lnk) + ');',
      '$s.TargetPath = ' + psLiteral(INSTALLED_EXE) + ';',
      "$s.Arguments = '--launch-chrome';",
      '$s.WorkingDirectory = ' + psLiteral(INSTALL_DIR) + ';',
      '$s.Description = ' + psLiteral('Open the dedicated WriteHuman Chrome') + ';',
      '$s.Save();',
    ].join(' ');
    try { spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 15000 }); } catch (_) {}
  }
}

/** Write config.json only if absent, so a reinstall never clobbers a working setup. */
function writeDefaultConfig() {
  const cfgPath = CONFIG_FILE;
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

function readInstalledCfg() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return {}; } }
function effectiveStatePaths(){
  const cfg=readCfg();
  const device=process.env.WHV2_DEVICE_STATE||cfg.deviceStateFile||CREDS_FILE;
  return {device,standDown:process.env.WHV2_STAND_DOWN||cfg.standDownFile||path.join(path.dirname(device),'stood-down.json'),
    recovery:process.env.WHV2_RELOGIN_STATE||cfg.reloginStateFile||path.join(path.dirname(device),'agent-relogin.json'),
    vault:process.env.WHV2_CREDENTIAL_VAULT||cfg.credentialVaultFile||path.join(path.dirname(device),'source-credential.dpapi'),
    lock:process.env.WHV2_LOCK_FILE||cfg.lockFile||LOCK_FILE};
}
function readCreds() { try { return JSON.parse(fs.readFileSync(effectiveStatePaths().device, 'utf8')); } catch (_) { return null; } }

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
  const localStandDown = fs.existsSync(effectiveStatePaths().standDown);
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
    if (r.ok && body && body.ok) return { have: true, ok: true, state: ['ACTIVE','STANDBY','PENDING','AUTHORIZED','REVOKED','UNINSTALLED','SUPERSEDED'].includes(body.deviceState)?body.deviceState:null, deviceId: creds.deviceId, localStandDown };
    if (r.status === 403 && body) {
      return { have: true, ok: false, reauthorize: body.reauthorize !== false, code: diagnosticCode(body.code)||'unknown', hint: null, deviceId: creds.deviceId, localStandDown };
    }
    return { have: true, unreachable: true, status: r.status, deviceId: creds.deviceId, localStandDown };
  } catch (e) {
    // A local stand-down marker is evidence the SERVER already refused this credential, recorded
    // when we could still reach it. Trust it when the network is down now.
    if (localStandDown) return { have: true, ok: false, reauthorize: true, code: 'LOCAL_STAND_DOWN', deviceId: creds.deviceId, localStandDown };
    return { have: true, unreachable: true, error: 'transport_error', deviceId: creds.deviceId, localStandDown };
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
  const files=effectiveStatePaths();
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const moves=[];
  try{
    for(const source of [files.device,files.standDown]){
      if(!fs.existsSync(source))continue;
      const destination=source+'.retired-'+stamp+'.json';
      fs.renameSync(source,destination);moves.push({source,destination});
    }
  }catch(_){
    let restored=true;
    for(const move of moves.reverse())try{fs.renameSync(move.destination,move.source);}catch(_){restored=false;}
    throw new Error(restored?'Identity archival failed; original files were retained.':'Identity archival failed; restore the secured backup before restarting.');
  }
  log('Local identity archived after explicit reauthorization approval');
  return moves.find(x=>x.source===files.device)?.destination||null;
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
    return { reported: !!(body && body.ok), status: r.status, body:body?{ok:body.ok===true,alreadyRetired:body.alreadyRetired===true,activeSourceCleared:body.activeSourceCleared===true,code:diagnosticCode(body.code)||'unknown'}:null };
  } catch (e) { return { reported: false, error: 'transport_error' }; }
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
    // Never recursively remove a configured installation folder: it can contain
    // other tools. Only delete our executable, then remove the directory if empty.
    const ps="$ErrorActionPreference='SilentlyContinue';"+
      'for($i=0;$i -lt 5;$i++){Start-Sleep -Seconds 3;Remove-Item -LiteralPath '+psLiteral(INSTALLED_EXE)+
      ' -Force;if(!(Test-Path -LiteralPath '+psLiteral(INSTALLED_EXE)+')){break}};'+
      'if((Test-Path -LiteralPath '+psLiteral(INSTALL_DIR)+') -and !(Get-ChildItem -LiteralPath '+psLiteral(INSTALL_DIR)+
      ' -Force)){Remove-Item -LiteralPath '+psLiteral(INSTALL_DIR)+'}';
    spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{detached:true,stdio:'ignore',windowsHide:true,cwd:os.tmpdir()}).unref();
    return true;
  }catch(_){log('Executable deletion could not be scheduled');return false;}
}

function purgeOwnedChromeProfile(profile){
  // A custom path may contain unrelated data. Retain it for operator review.
  if(path.resolve(profile).toLowerCase()!==path.resolve(CHROME_PROFILE_DIR).toLowerCase())return false;
  try{
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      "$ErrorActionPreference='Stop';ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object -ExpandProperty ProcessId) -Compress"],
      {encoding:'utf8',windowsHide:true,timeout:10000});
    // Fail closed on unreadable process inventory. Never force-close Chrome.
    if(result.status!==0)return false;
    const ids=JSON.parse(result.stdout);if(!Array.isArray(ids)||ids.length)return false;
    return rmrf(profile);
  }catch(_){return false;}
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
  const files=effectiveStatePaths(),profile=chromeProfileDir();

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
  const failed=[];
  for(const f of [files.device,files.standDown,files.recovery,files.vault,files.lock,CONFIG_FILE,INSTALLED_MARKER]){
    try{fs.unlinkSync(f);}catch(e){if(e.code!=='ENOENT')failed.push(f);}
  }
  // Remove only empty owned directories; retain archived identities and other files.
  for(const d of [CREDS_DIR,path.join(INSTALL_DIR,'config')]){try{fs.rmdirSync(d);}catch(_){}}
  steps.push(failed.length?'config/identity cleanup: INCOMPLETE — review local files':'config, identity and credential: removed');
  if(o.removeChromeProfile&&purgeOwnedChromeProfile(profile)){
    steps.push('WriteHuman Chrome profile: removed (you will need to sign in again next time)');
  }else{
    steps.push('WriteHuman Chrome profile: KEPT at '+profile+(o.removeChromeProfile?' — close Chrome and review this path before manual deletion':''));
  }

  const scheduled = scheduleSelfDelete();
  steps.push('program files: ' + (scheduled ? 'removed after exit' : 'left at ' + INSTALL_DIR + ' (remove by hand)'));

  log('uninstall complete:\n  - ' + steps.join('\n  - '));
  return { ok: failed.length===0, steps, server };
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
    '$s = $w.CreateShortcut(' + psLiteral(UNINSTALL_LNK()) + ');',
    '$s.TargetPath = ' + psLiteral(INSTALLED_EXE) + ';',
    "$s.Arguments = '--uninstall';",
    '$s.WorkingDirectory = ' + psLiteral(INSTALL_DIR) + ';',
    '$s.Description = ' + psLiteral('Remove the WriteHuman Agent from this computer') + ';',
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
    "$s = $w.CreateShortcut(" + psLiteral(lnk) + ");",
    "$s.TargetPath = " + psLiteral(INSTALLED_EXE) + ";",
    "$s.Arguments = '--agent';",
    "$s.WorkingDirectory = " + psLiteral(INSTALL_DIR) + ";",
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
    const lk = JSON.parse(fs.readFileSync(effectiveStatePaths().lock, 'utf8'));
    if (!lk || !lk.pid) return false;
    const fresh = lk.at && (Date.now() - new Date(lk.at).getTime()) < 10 * 60000;
    if (!fresh) return false;
    try { process.kill(lk.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  } catch (_) { return false; }
}

/**
 * Stop a running installed agent so its exe can be replaced (a running exe is locked on Windows).
 * Kills only other processes at our exact installed image path. The current
 * installer/uninstaller PID is always excluded, including installed --uninstall. The server keeps serving the last verified bundle while the agent is briefly down; the
 * 'Starting Agent' stage brings it back with the SAME device identity (creds are never removed).
 */
function stopRunningAgent() {
  // Do not trust a stale PID file and never use taskkill /IM: another Windows
  // user's Agent may have the same image name. Match the full installed path.
  const cmd="$ErrorActionPreference='Stop';$target="+psLiteral(INSTALLED_EXE)+";"+
    "Get-CimInstance Win32_Process -Filter \"Name='WriteHumanAgent.exe'\" | "+
    "Where-Object {$_.ProcessId -ne "+process.pid+" -and $_.ExecutablePath -and [String]::Equals($_.ExecutablePath,$target,[StringComparison]::OrdinalIgnoreCase)} | "+
    "ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop}";
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{stdio:'ignore',windowsHide:true,timeout:15000});
  if(result.status!==0)throw new Error('Could not stop only this installed Agent. No image-name-wide kill was attempted.');
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
    const marker=readJsonStrict(INSTALLED_MARKER);
    return marker.agentVersion===selfAgentVersion() && marker.buildId===selfBuildId() &&
      marker.sourceSha256===sha256(agentSource()) &&
      sha256(fs.readFileSync(INSTALLED_EXE))===sha256(fs.readFileSync(selfPath()));
  } catch (_) { return false; }
}

/**
 * Run the ordered install stages, printing each to the console (for terminal runs) and stopping at
 * the first failure with its own exit code. Returns { ok, code, stage, error }.
 */
function startInstalledAgent() {
  return new Promise((resolve,reject)=>{
    let child,settled=false;
    const timer=setTimeout(()=>done(new Error('Agent spawn timed out.')),10000);
    const done=(error)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error)reject(error);else{child.unref();resolve();}
    };
    try {
      child=spawn(INSTALLED_EXE,['--agent'],{detached:true,stdio:'ignore',cwd:INSTALL_DIR,windowsHide:true});
      child.once('error',()=>done(new Error('Could not start the installed Agent process.')));
      child.once('spawn',()=>done());
    } catch(_){done(new Error('Could not spawn the installed Agent process.'));}
  });
}

async function runStages(isRepair,existingBackup) {
  let backup=existingBackup||null;
  const stages = [
    ['Verifying installer', () => { validateUpgrade(); }],
    ['Backing up existing installation', () => { if(!backup)backup=backupInstallation(); }],
    ['Installing WriteHuman Agent', () => {
      try {
        ensureDirs();
        if (path.resolve(selfPath()).toLowerCase() !== path.resolve(INSTALLED_EXE).toLowerCase()) {
          // Update/repair: a running agent locks its own exe, so stop it before replacing, then
          // copy with retries while the handle releases. Fresh install: nothing to stop.
          if (fs.existsSync(INSTALLED_EXE)) stopRunningAgent();
          copyWithRetry(selfPath(), INSTALLED_EXE);
          if(sha256(fs.readFileSync(selfPath()))!==sha256(fs.readFileSync(INSTALLED_EXE))) throw new Error('Installed executable checksum mismatch.');
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
    ['Opening WriteHuman Chrome', async () => {
      try {
        fs.mkdirSync(chromeProfileDir(), { recursive: true });
        createChromeShortcuts();
      } catch (e) { e.exit = EXIT.CHROME_FAILED; throw e; }
      const ready=await launchChrome(); // Await the real result instead of exiting with a pending launch.
      if(!ready){const e=new Error('Dedicated Chrome did not become ready. The backup is retained.');e.exit=EXIT.CHROME_FAILED;throw e;}
    }],
    ['Starting Agent', async () => {
      try { await startInstalledAgent(); }
      catch(e){e.exit=EXIT.AGENT_FAILED;throw e;}
    }],
  ];
  for (const [name, fn] of stages) {
    log((isRepair ? 'repair: ' : '') + name + '…');
    try { await fn(); }
    catch (e) { return { ok: false, code: e.exit || EXIT.FILE_FAILED, stage: name, error: e.message, backup }; }
  }
  return { ok: true, code: isRepair ? EXIT.REPAIRED : EXIT.SUCCESS, stage: null, error: null, backup };
}

/** Confirm the agent process actually came up within a short window (visible pending vs. failed). */
async function waitForAgent(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  while (Date.now() < deadline) {
    if (isAgentRunning()) return true;
    await new Promise(resolve=>setTimeout(resolve,750));
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
  validateUpgrade();
  if(process.env.WHV2_SILENT!=='1' && messageBox(
    'WriteHuman Agent ' + (selfAgentVersion() || '?') + ' - RELEASE CANDIDATE\n\n'+
    'This package contains the runtime and recovery code. No build tools are downloaded.\n\n'+
    'Install only on your authorized Windows source RDP as its existing Agent user. A private backup is made before an upgrade. Settings, enrollment and the source Chrome profile are retained.\n\n'+
    'Existing enabled recovery may run after upgrade. Global session reset requires a separate scoped consent or valid time-limited authorization, and remains limited to once per 24 hours.\n\n'+
    'This package has not been executed on Windows by the author; local installation and real provider login need verification. Continue?',
    'WriteHuman Agent - offline installation','OKCancel','Information')!=='OK') return;
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
    if(choice!=='OK')return;
    const backup=backupInstallation();
    stopRunningAgent();
    archiveIdentity(probe.code || 'credential rejected');
    return finishInstall(false, { reauthorized: true, backup });
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
    if (r === 'Yes') { await launchChrome(); process.exit(EXIT.ALREADY); }
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
    'Yes → Delete the default dedicated profile if Chrome is closed. Custom profiles are kept for manual review.',
    'WriteHuman Agent — Uninstall', 'YesNo', 'Question');
  const res = await doUninstall({ removeChromeProfile: keep === 'Yes' });
  messageBox(
    (res.ok?'WriteHuman Agent removal completed.':'Agent removal needs manual cleanup.')+'\n\n' +
    res.steps.map(s => '• ' + s).join('\n') + '\n\n' +
    'The WriteHuman session stored on the server is unchanged, and no other computer was\n' +
    'automatically made the active source.',
    'WriteHuman Agent — Uninstalled', 'OK', 'Information');
  process.exit(res.ok?EXIT.SUCCESS:EXIT.FILE_FAILED);
}

async function finishInstall(isRepair, opts) {
  const o = opts || {};
  const res = await runStages(isRepair,o.backup);
  if (!res.ok) {
    const codeName = Object.keys(EXIT).find(k => EXIT[k] === res.code) || 'FILE_FAILED';
    log('installation FAILED at:', res.stage, '-', res.error, '(exit', res.code + ')');
    messageBox(
      'Installation failed while: ' + res.stage + '.\n\n' +
      'Error code: ' + codeName + '\n' +
      'Log: ' + path.join(INSTALL_DIR, 'logs', 'agent.log') + '\n' +
      (res.backup ? 'Private backup: '+res.backup+'\n\n' : '\n') +
      'Double-click the installer again to retry or repair.',
      'WriteHuman Agent — Installation failed', 'OK', 'Error');
    process.exit(res.code);
  }

  // Success path: confirm the agent actually started so we show a truthful message. A cold SEA
  // (~90 MB) plus first enrolment/CDP handshake can take >12s, so give it a real window.
  const up = await waitForAgent(30000);
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
  if (r === 'Yes') await launchChrome();
  process.exit(up ? res.code : EXIT.ENROL_PENDING);
}

const DIAGNOSTIC_CODES=new Set(('MONITORING LOGIN_REQUIRED PAGE_RECHECK RELOAD_ONCE LOGIN_CONTROL_FOUND NAVIGATION FORM_READY EMAIL_SUBMITTED LOGIN_SUBMITTED BROWSER_CANDIDATE BACKEND_VERIFIED SYNC_RESUMED FAILED MANUAL_ACTION VERIFY_PENDING DISABLED '+
  'SESSION_CHECK LOGIN_UI_MISSING PAGE_RELOAD_REQUESTED PAGE_RELOAD_COMPLETED LOGIN_CLICKED LOGIN_FORM_READY CREDENTIALS_AVAILABLE PROVIDER_AUTHENTICATED BACKEND_VERIFICATION_PENDING BACKEND_VERIFICATION_REJECTED RECOVERY_FAILED RECOVERY_RETRY_ELIGIBLE MANUAL_INTERVENTION_REQUIRED RECOVERY_BLOCKED RETRY_WAIT page_reload_timeout page_wait_timeout recovery_deadline_exceeded multiple_approved_tabs page_wait_completed loading session_limit authenticated login_required login_entry editor_busy disabled not_active_source stood_down already_running unsupported_platform '+
  'confirmed wrong_credentials mfa_required captcha_required rate_limited account_restricted wrong_account state_unreadable state_unwritable submission_outcome_unknown '+
  'session_limit_requires_manual_reset session_limit_live_authorization_required session_limit_control_unverified session_limit_reset_budget_exhausted session_limit_reset_failed session_limit_after_reset '+
  'browser_authenticated_pending_verification already_authenticated verification_pending source_page_busy no_tab no_vault login_form_not_found password_form_not_found '+
  'cdp_not_local cdp_unreachable cdp_discovery_failed cdp_chrome_too_old cdp_cookie_read_failed cdp_read_failed no_profile_proof wrong_chrome_profile untrusted_cdp_page unapproved_login_origin unapproved_form_action ambiguous_login_form invalid_login_config '+
  'field_not_found_or_bad_origin field_set_failed login_form_changed submit_not_found submit_still_disabled source_page_changed login_entry_changed login_navigation_failed '+
  'relogin_state_unwritable cdp_ws_error cdp_ws_closed cdp_connect_timeout cdp_session_timeout cdp_command_failed cdp_command_timeout recovery_exception '+
  'budget_exhausted cooldown no_logout_evidence visible_login_entry visible_login_form provider_session_expired auth_cookie_absent startup_auth_cookie_absent '+
  'reload_requested login_control_clicked login_page_requested existing_form browser_autofill local_vault '+
  'PROMOTED COOKIE_BUNDLE_UNCHANGED VERIFICATION_INCONCLUSIVE SESSION_EXPIRED ACCOUNT_MISMATCH STALE_BUNDLE REPLAY_REJECTED STANDBY_ROUTINE_REFRESH DEVICE_REVOKED DEVICE_UNINSTALLED DEVICE_SUPERSEDED '+
  'unconfirmed_verification_timeout unconfirmed_visible_logout rejected response unknown challenge_review_acknowledged captcha_halt_revalidated captcha_recheck_deferred captcha_review_required').split(/\s+/));
function diagnosticCode(value){
  if(typeof value!=='string')return null;
  if(DIAGNOSTIC_CODES.has(value))return value;
  if(value.startsWith('unconfirmed_')&&DIAGNOSTIC_CODES.has(value.slice(12)))return value;
  if(value.startsWith('halted_')&&DIAGNOSTIC_CODES.has(value.slice(7)))return value;
  return null;
}
function workflowStatus() {
  const cfg=readCfg();
  const deviceFile=process.env.WHV2_DEVICE_STATE||cfg.deviceStateFile||CREDS_FILE;
  const stateFile=process.env.WHV2_RELOGIN_STATE||cfg.reloginStateFile||path.join(path.dirname(deviceFile),'agent-relogin.json');
  const vault=process.env.WHV2_CREDENTIAL_VAULT||cfg.credentialVaultFile||path.join(path.dirname(deviceFile),'source-credential.dpapi');
  let st={},readable=true;try{st=readJsonStrict(stateFile);}catch(e){if(e.code!=='ENOENT'){st={haltedReason:'state_unreadable'};readable=false;}}
  if(!st||typeof st!=='object'||Array.isArray(st)){st={haltedReason:'state_unreadable'};readable=false;}
  for(const key of ['attempts','sessionLimitResets','captchaAutoResumes'])if(st[key]!=null&&(!Array.isArray(st[key])||!st[key].every(Number.isFinite)))readable=false;
  for(const key of ['pendingVerification','captchaHaltPreSubmit'])if(st[key]!=null&&typeof st[key]!=='boolean')readable=false;
  if(st.captchaRecheckAt!=null&&(!Number.isFinite(st.captchaRecheckAt)||st.captchaRecheckAt<0))readable=false;
  if(Array.isArray(st.captchaAutoResumes)&&st.captchaAutoResumes.some(n=>n<0))readable=false;
  if(st.incident!=null&&(typeof st.incident!=='object'||Array.isArray(st.incident)||!/^[a-f0-9-]{36}$/.test(String(st.incident.id))))readable=false;
  for(const key of ['reloaded','navigationClicked','routeNavigated','emailSubmitted','credentialSubmitted','closed'])if(st.incident?.[key]!=null&&typeof st.incident[key]!=='boolean')readable=false;
  if(st.captchaHaltPreSubmit===true&&st.incident?.credentialSubmitted!==false)readable=false;
  const raw=process.env.WHV2_RELOGIN!=null?process.env.WHV2_RELOGIN:cfg.reloginEnabled;
  const enabled=/^(1|true|yes)$/i.test(String(raw||''));
  const lastOutcome=diagnosticCode(st.lastOutcome);
  const halted=!readable?'state_unreadable':diagnosticCode(st.haltedReason)||(st.haltedReason?'state_unreadable':null);
  const unresolved=st.pendingVerification===true||(st.incident?.credentialSubmitted===true&&st.incident.closed!==true);
  const resetEnabled=/^(1|true|yes)$/i.test(String(process.env.WHV2_SESSION_LIMIT_SIGNOUT_ALL||cfg.sessionLimitSignOutAll||''));
  const consent=process.env.WHV2_SESSION_LIMIT_CONSENT||cfg.sessionLimitConsent;
  const until=Date.parse(process.env.WHV2_SESSION_LIMIT_AUTHORIZED_UNTIL||cfg.sessionLimitLiveAuthorizationUntil||'');
  return {version:selfAgentVersion(),buildId:selfBuildId(),installedVersion:installedAgentVersion(),
    autoReloginConfigured:enabled,vaultFilePresent:fs.existsSync(vault),
    stage:!enabled?'DISABLED':halted?'MANUAL_ACTION':st.pendingVerification===true?'VERIFY_PENDING':diagnosticCode(st.incident?.stage)||'MONITORING',
    stageScope:'last_recovery_incident',browserLoginVerified:false,
    lastOutcome,haltedReason:halted,pendingVerification:st.pendingVerification===true,
    recoveryStateReadable:readable,submissionUnresolved:unresolved,
    sessionLimitRecoveryAuthorized:resetEnabled&&(consent==='official-provider-session-limit-v1'||(Number.isFinite(until)&&until>Date.now()&&until-Date.now()<=86400000)),
    captchaRecoveryMode:halted==='captcha_required'&&readable&&!unresolved&&st.captchaHaltPreSubmit===true&&st.incident?.stage==='MANUAL_ACTION'&&!st.incident.closed?'bounded_automatic_recheck':halted?'operator_review_required':'not_halted',
    lastBlock:st.lastBlock?{reason:diagnosticCode(st.lastBlock.reason),at:typeof st.lastBlock.at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(st.lastBlock.at)?st.lastBlock.at:null}:null,
    incident:st.incident&&/^[a-f0-9-]{36}$/.test(String(st.incident.id))?{id:st.incident.id,stage:diagnosticCode(st.incident.stage),closed:st.incident.closed===true,credentialSubmitted:typeof st.incident.credentialSubmitted==='boolean'?st.incident.credentialSubmitted:null}:null,
    manualRequired:!!halted,
    haltedAt:typeof st.haltedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(st.haltedAt)?st.haltedAt:null,
    note:'Stage and lastBlock describe saved history, not the current browser or retry eligibility. Use --recovery-diagnostics for a read-only current observation; browser presence alone does not prove backend synchronization.'};
}

function diagnosticExport(){
  const events=[];
  // Read only the bounded tail of known local log files. Never attach raw logs,
  // config, device keys, vaults, page URLs, account names or backup directories.
  for(const suffix of [...Array.from({length:logSettings().retainedFiles},(_,i)=>'.'+(logSettings().retainedFiles-i)),'']){
    let fd;
    try{
      const file=path.join(INSTALL_DIR,'logs','agent.log'+suffix),size=fs.statSync(file).size;
      fd=fs.openSync(file,'r');const data=Buffer.alloc(Math.min(size,256*1024));
      fs.readSync(fd,data,0,data.length,Math.max(0,size-data.length));
      for(const line of data.toString('utf8').split('\n')){
        const m=line.match(/^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\] \[wh-v2-agent\] (recovery_transition|relogin_page_wait) (\{.*\})$/);
        if(!m)continue;
        let raw;try{raw=JSON.parse(m[3]);}catch(_){continue;}
        if(m[2]==='relogin_page_wait'){
          const reason=diagnosticCode(raw.reason);if(!['page_wait_completed','page_wait_timeout'].includes(reason))continue;
          const item={at:m[1],event:'PAGE_WAIT_OBSERVATION',reason,state:diagnosticCode(raw.state)};
          for(const k of ['duration_ms','samples','transient_errors'])if(Number.isFinite(raw[k])&&raw[k]>=0)item[k]=raw[k];
          for(const k of ['document_changed','page_ready'])if(typeof raw[k]==='boolean')item[k]=raw[k];
          events.push(item);if(events.length>200)events.shift();continue;
        }
        const stage=diagnosticCode(raw.stage);if(!stage)continue;
        const item={at:m[1],stage,event:diagnosticCode(raw.event),reason:diagnosticCode(raw.reason)};
        if(typeof raw.build_id==='string'&&/^3\.\d+\.\d+-(?:recovery|regression|audit|captcha|retry)-rc\d{1,3}$/.test(raw.build_id))item.buildId=raw.build_id;
        if(/^[a-f0-9-]{36}$/.test(String(raw.incident_id)))item.incident_id=raw.incident_id;
        for(const k of ['duration_ms','stage_duration_ms','attempt_count'])if(Number.isFinite(raw[k])&&raw[k]>=0)item[k]=raw[k];
        if(typeof raw.manual_required==='boolean')item.manual_required=raw.manual_required;
        if(typeof raw.next_retry_at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.next_retry_at))item.next_retry_at=raw.next_retry_at;
        events.push(item);if(events.length>200)events.shift();
      }
    }catch(_){}finally{if(fd!=null)try{fs.closeSync(fd);}catch(_){}}
  }
  return {schema:1,createdAt:new Date().toISOString(),package:validatePackage(),workflow:workflowStatus(),events,
    validation:'Local diagnostics only; no Windows/provider acceptance is implied.'};
}

function rollbackCompatibility(){
  let cfg;try{cfg=readJsonStrict(CONFIG_FILE);}catch(_){return {allowed:false,reason:'configuration_unreadable'};}
  if(!cfg||typeof cfg!=='object'||Array.isArray(cfg))return {allowed:false,reason:'configuration_unreadable'};
  // A temporary environment override cannot guarantee safety at the next logon.
  if([cfg.reloginEnabled,process.env.WHV2_RELOGIN].some(raw=>/^(1|true|yes)$/i.test(String(raw||''))))
    return {allowed:false,reason:'disable_recovery_before_incompatible_rollback'};
  let st;
  try{st=readJsonStrict(effectiveStatePaths().recovery);}catch(e){
    return e.code==='ENOENT'?{allowed:true,reason:'recovery_disabled_no_incident'}:{allowed:false,reason:'state_unreadable'};
  }
  if(!st||typeof st!=='object'||Array.isArray(st))return {allowed:false,reason:'state_unreadable'};
  if(st.pendingVerification===true||(st.incident&&st.incident.closed!==true))return {allowed:false,reason:'unresolved_recovery_incident'};
  return {allowed:true,reason:'recovery_disabled_no_open_incident'};
}

function main() {
  const args = process.argv.slice(2).map(a => String(a).toLowerCase());
  const arg = args[0] || '';

  // No configuration, credential decryption, browser or network access.
  if (arg === '--package-info' || arg === '--self-test') {
    console.log(JSON.stringify(validatePackage()));
    return;
  }
  if (arg === '--workflow-status') {
    console.log(JSON.stringify(workflowStatus(),null,2));return;
  }
  if(arg==='--connection-check'){
    localReviewAgent().connectionStatus().then(connection=>console.log(JSON.stringify({package:validatePackage(),connection},null,2)))
      .catch(()=>{console.error('Connection diagnostic could not complete.');process.exitCode=1;});return;
  }
  if(arg==='--recovery-diagnostics'){
    localReviewAgent().recoveryDiagnostics().then(current=>console.log(JSON.stringify({...diagnosticExport(),current},null,2)))
      .catch(()=>{console.error('Recovery diagnostic could not complete.');process.exitCode=1;});return;
  }
  if(arg==='--diagnostics'){
    localReviewAgent().connectionStatus().then(connection=>console.log(JSON.stringify({...diagnosticExport(),connection},null,2)))
      .catch(()=>{console.error('Connection diagnostic could not complete.');process.exitCode=1;});return;
  }
  if(arg==='--rollback-check'){
    console.log(JSON.stringify(rollbackCompatibility()));return;
  }
  if(arg==='--acknowledge-resolved-challenge'){
    acknowledgeRecoveryChallenge().then(result=>{console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;})
      .catch(()=>{console.error('Challenge review could not complete.');process.exitCode=1;});return;
  }
  if(arg==='--authorize-session-limit-recovery'){
    authorizeSessionLimitRecovery().then(result=>{console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;})
      .catch(()=>{console.log(JSON.stringify({ok:false,code:'configuration_write_failed'}));process.exitCode=1;});return;
  }

  if (arg === '--uninstall') {
    // Silent/scripted uninstall (also what QuietUninstallString in Add/Remove Programs invokes),
    // or the interactive one that asks the single question worth asking.
    const silent = args.includes('--silent') || process.env.WHV2_SILENT === '1';
    const purge = args.includes('--purge-chrome-profile');
    if (silent) {
      doUninstall({ removeChromeProfile: purge })
        .then(result => process.exit(result.ok?EXIT.SUCCESS:EXIT.FILE_FAILED))
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
