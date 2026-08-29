'use strict';
/**
 * UNINSTALL AND RE-AUTHORIZATION — the two Windows-side failures, pinned.
 *
 * These are static guards over `wh-agent-sea.js` and `cookie-sync-agent.js` rather than behavioural
 * tests, because the subject is a Windows SEA executable that registers logon shortcuts, writes to
 * %LOCALAPPDATA% and talks to the live API. It cannot be exercised on CI, and "cannot be tested"
 * is exactly how both of these shipped broken. A structural assertion that the code contains the
 * step is weaker than running it — and far stronger than nothing, because in both cases the step
 * was entirely ABSENT, not merely wrong.
 *
 * WHAT WAS ACTUALLY WRONG
 * -----------------------
 * 1. UNINSTALL. `--uninstall` deleted three shortcuts and returned. It did not stop the running
 *    agent, did not remove the exe, config.json, agent.lock, installed.json or — the one that
 *    matters — `creds/agent-device.json`, and it never told the server. So after "uninstalling",
 *    the machine still had a live agent process holding a valid credential, still auto-started at
 *    every logon, and still appeared as a live device on the server for ever. There was also no way
 *    to REACH it: no Add/Remove Programs entry, no Start-Menu shortcut, and double-clicking the
 *    installed exe runs the agent. On a locked-down RDP that is indistinguishable from "this
 *    software cannot be removed".
 *
 * 2. RE-AUTHORIZATION. `run()` loaded `agent-device.json` and, if it contained a deviceKey, used it
 *    for ever. The browser-enrolment branch was `if (!device.deviceKey && !CFG.agentKey)`, so a
 *    device holding a REVOKED key never re-enrolled — it just 403'd. And because uninstall never
 *    removed the creds file, reinstalling handed the same revoked credential straight back. The
 *    live evidence on this machine: a fresh 3.4.0 install at 07:55:47Z reused
 *    `agent_2cf60e01fbc6634a74fa169b0f4faa0d` and logged
 *    `stand_down {"code":"DEVICE_REVOKED"}` eight seconds later.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SEA = fs.readFileSync(path.join(ROOT, 'writehuman-v2', 'agent', 'wh-agent-sea.js'), 'utf8');
const AGENT = fs.readFileSync(path.join(ROOT, 'writehuman-v2', 'agent', 'cookie-sync-agent.js'), 'utf8');

/** The body of a named top-level function, so an assertion is about THAT function, not the file. */
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > -1, 'function ' + name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

// ── 1. UNINSTALL ──────────────────────────────────────────────────────────────
test('uninstall removes every piece of local state the install created', () => {
  const body = fnBody(SEA, 'doUninstall');
  // The credential is the important one: leaving it behind is what let a "removed" agent go on
  // authenticating, and what let a reinstall silently reuse a dead identity.
  for (const owned of ['CREDS_FILE', 'STAND_DOWN_FILE', 'CONFIG_FILE', 'LOCK_FILE', 'INSTALLED_MARKER', 'CREDS_DIR']) {
    assert.ok(body.includes(owned), 'uninstall must remove ' + owned);
  }
  assert.ok(body.includes('stopRunningAgent()'), 'uninstall must stop the running agent — it holds the exe open and keeps syncing');
  assert.ok(body.includes('removeAutoStart()'), 'uninstall must remove the logon shortcut, or it comes back at the next sign-in');
  assert.ok(body.includes('removeUninstallEntry()'), 'uninstall must remove its own Add/Remove Programs entry');
  assert.ok(body.includes('scheduleSelfDelete()'), 'a running exe cannot delete itself; the removal must be handed to a detached process');
});

test('uninstall tells the server BEFORE it destroys the credential it needs to prove who it is', () => {
  const body = fnBody(SEA, 'doUninstall');
  const reported = body.indexOf('reportUninstallToServer');
  const wiped = body.indexOf('CREDS_FILE');
  assert.ok(reported > -1, 'uninstall must report itself to the server');
  assert.ok(wiped > -1);
  assert.ok(reported < wiped,
    'the server call must come first — afterwards there is no credential left to authenticate the report, '
    + 'and the device row would stay live for ever with nothing to close it');
});

test('uninstall keeps the WriteHuman Chrome profile by default, and only removes it on request', () => {
  const body = fnBody(SEA, 'doUninstall');
  assert.ok(/if \(o\.removeChromeProfile\)/.test(body),
    'removing the profile must be conditional — it holds the operator’s WriteHuman login');
  assert.ok(body.includes('KEPT'), 'the default path must state that the profile was kept');
  // And the choice must be offered explicitly rather than assumed either way.
  assert.ok(/Also remove WriteHuman Chrome profile data/.test(SEA),
    'the advanced choice must be offered in the uninstall dialog');
  assert.ok(/No\s+→ Keep it \(recommended\)/.test(SEA), 'keeping the profile must be the recommended default');
});

test('the uninstaller is reachable the two ways a Windows user actually looks', () => {
  assert.ok(/UNINSTALL_REG_KEY\s*=\s*'HKCU/.test(SEA), 'a per-user Add/Remove Programs entry must exist');
  const reg = fnBody(SEA, 'registerUninstallEntry');
  assert.ok(reg.includes('UninstallString'), 'Settings ▸ Apps needs an UninstallString');
  assert.ok(reg.includes('QuietUninstallString'), 'scripted removal needs a quiet uninstall string');
  assert.ok(reg.includes('Uninstall WriteHuman Agent.lnk') || /UNINSTALL_LNK\(\)/.test(reg),
    'a Start-Menu uninstall shortcut must be created');
  assert.ok(fnBody(SEA, 'runStages').includes('registerUninstallEntry()'),
    'the entry must be written during installation, not only mentioned');
});

test('uninstall never deletes the stored session, and never picks a replacement source', () => {
  // Both are server-side promises; the uninstall route is what keeps them.
  const route = fs.readFileSync(path.join(ROOT, 'backend', 'routes', 'proxy', 'agentSync.js'), 'utf8');
  assert.ok(/bundlePreserved/.test(route), 'the uninstall response must state that the bundle survives');
  assert.ok(/no replacement source was selected automatically/.test(route),
    'the uninstall response must state that nothing was auto-selected in its place');
  const ds = fs.readFileSync(path.join(ROOT, 'backend', 'utils', 'proxy', 'deviceSync.js'), 'utf8');
  const mark = fnBody(ds, 'markUninstalled');
  assert.ok(mark.includes('account.activeSource = null'), 'a retired machine must not remain the named active source');
  assert.ok(!/activeSource\s*=\s*\{/.test(mark), 'markUninstalled must never appoint a new active source');
});

// ── 2. RE-AUTHORIZATION ───────────────────────────────────────────────────────
test('the installer asks the SERVER about the local credential before deciding what to do', () => {
  assert.ok(SEA.includes('function probeCredential'), 'the installer must probe the credential');
  assert.ok(/device-status/.test(SEA), 'the probe must use the side-effect-free device-status endpoint');
  const run = fnBody(SEA, 'runInstaller');
  assert.ok(/await probeCredential\(\)/.test(run), 'runInstaller must actually call the probe');
  assert.ok(/probe\.reauthorize/.test(run), 'the probe result must drive the branch');
});

test('a rejected credential is archived and a FRESH authorization is started — never reused', () => {
  const run = fnBody(SEA, 'runInstaller');
  const reauthBranch = run.slice(run.indexOf('probe.reauthorize'), run.indexOf('const healthy'));
  assert.ok(reauthBranch.includes('archiveIdentity('),
    'a rejected credential must be retired before installing, or the agent picks it straight back up');
  assert.ok(reauthBranch.includes('stopRunningAgent()'),
    'the old agent must be stopped first — it is still holding the dead credential');
  assert.ok(reauthBranch.includes('reauthorized: true'), 'the operator must be told a new authorization is starting');

  const archive = fnBody(SEA, 'archiveIdentity');
  assert.ok(archive.includes('STAND_DOWN_FILE'),
    'the dormancy marker must be cleared, or the freshly installed agent stays dormant for ever');
  assert.ok(/agent-device\.retired-/.test(archive), 'the old identity is archived for audit, not silently destroyed');
});

test('re-authorization creates a NEW identity; the revoked row is never un-revoked', () => {
  // Agent side: no credential -> browser PKCE enrolment, which an admin must approve.
  assert.ok(/enrollViaBrowser\(/.test(AGENT), 'the agent must be able to start a browser authorization');
  // Server side: a revoked / uninstalled / superseded id can never be re-registered under itself.
  const ds = fs.readFileSync(path.join(ROOT, 'backend', 'utils', 'proxy', 'deviceSync.js'), 'utf8');
  const auto = fnBody(ds, 'autoRegisterDevice');
  for (const code of ['DEVICE_REVOKED', 'DEVICE_UNINSTALLED', 'DEVICE_SUPERSEDED']) {
    assert.ok(auto.includes(code), 'autoRegisterDevice must refuse to resurrect a ' + code + ' row');
  }
});

test('a duplicate operational row cannot survive a reinstall', () => {
  const ds = fs.readFileSync(path.join(ROOT, 'backend', 'utils', 'proxy', 'deviceSync.js'), 'utf8');
  const sup = fnBody(ds, 'supersedePriorDevices');
  assert.ok(sup.includes('supersededBy'), 'prior rows for the same machine must be marked superseded');
  assert.ok(sup.includes('keyHash = null'), 'a superseded row must lose its credential');
  assert.ok(sup.includes('account.activeSource = null'),
    'if a superseded row held the title it must be released, with nothing auto-selected');
});

// ── 3. THE RETIRED AGENT STAYS RETIRED ────────────────────────────────────────
test('stand-down is written to disk and honoured at STARTUP, not just in memory', () => {
  assert.ok(/function writeStandDown/.test(AGENT) && /function readStandDown/.test(AGENT),
    'the stand-down must be persisted');
  const run = fnBody(AGENT, 'run');
  const firstStandDown = run.indexOf('readStandDown()');
  const firstDevice = run.indexOf('loadDeviceState()');
  assert.ok(firstStandDown > -1, 'run() must check the marker');
  assert.ok(firstStandDown < firstDevice,
    'the marker must be checked BEFORE the identity — a dormant install must never reach the poll loop, '
    + 'which is how a revoked machine went on relaunching its own Chrome after every logon');
  assert.ok(run.includes('process.exit(0)'), 'a retired installation exits rather than polling');
});

test('all three terminal refusals retire the agent, not just revocation', () => {
  assert.ok(/TERMINAL_CODES\s*=\s*\['DEVICE_REVOKED', 'DEVICE_UNINSTALLED', 'DEVICE_SUPERSEDED'\]/.test(AGENT),
    'a superseded duplicate and an uninstalled row used to keep polling for ever — only revoke was handled');
  const route = fs.readFileSync(path.join(ROOT, 'backend', 'routes', 'proxy', 'agentSync.js'), 'utf8');
  assert.ok(/TERMINAL_CODES\.includes\(a\.code\)/.test(route), 'the server must set standDown for all three');
  assert.ok(/function standDownHint/.test(route), 'each terminal reason needs its own remedy sentence');
});

test('a retired agent touches nothing: no cookie read, no Chrome, no upload', () => {
  const push = fnBody(AGENT, 'pushIfChanged');
  const guard = push.slice(0, push.indexOf('getAllCookiesViaCDP'));
  assert.ok(/if \(state\.standDown\)/.test(guard) && /return;/.test(guard),
    'the stand-down check must come before any CDP read');
  // 3.4.0 kept pinging every 15 minutes while retired, which kept a dead row looking half-awake.
  assert.ok(!/lastStandDownPingAt/.test(AGENT), 'a retired agent must not keep calling in');
});

test('only the ACTIVE source auto-relaunches Chrome, and an activation is the one exception', () => {
  const push = fnBody(AGENT, 'pushIfChanged');
  assert.ok(/state\.isActiveSource === true/.test(push),
    'auto-relaunch must be gated on being the active source — every installed agent used to relaunch its own Chrome');
  const act = fnBody(AGENT, 'runActivation');
  assert.ok(act.includes("relaunchChrome('activation:"),
    'a capture explicitly asked for by an admin is the one case a non-active machine may start its browser');
});
