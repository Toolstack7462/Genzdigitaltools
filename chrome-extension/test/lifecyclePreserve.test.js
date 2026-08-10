/**
 * PRESERVE / DO-NOT-TOUCH — extension access & session lifecycle.
 *
 * These lock the three behaviours that must survive any Claude UI work:
 *   1. inactivity expiry        (idle watchdog)
 *   2. admin/backend access end (assignment expired / revoked -> cookies + storage wiped)
 *   3. monthly expiry -> renewal (expired page -> Renew -> dashboard)
 *
 * They are intentionally VALUE locks, not behaviour descriptions: if someone changes the idle
 * window, the host list, or the terminal business codes, this suite fails and the change has to
 * be made deliberately rather than as a side effect of unrelated work.
 *
 * The Claude model/effort menu policy is a shield-layer DOM rule and must never appear in any
 * of these paths — asserted at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(EXT, p), 'utf8');
const TOOLCFG = read('js/config/toolConfigs.js');
const BG = read('js/background.js');
const SHIELD = read('js/shield.js');

// ── 1. INACTIVITY ─────────────────────────────────────────────────────────────
// Policy set 2026-08-10: 20 minutes, HIX AI + GPT Bypass ONLY.
const IDLE_MIN = TOOLCFG.match(/export const IDLE_TIMEOUT_MINUTES\s*=\s*(\d+)/);
const IDLE_HOSTS = (() => {
  const m = TOOLCFG.match(/export const IDLE_TIMEOUT_HOSTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'IDLE_TIMEOUT_HOSTS must exist');
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
})();
// Mirrors idleHostMatch(): exact host or a subdomain of one.
const idleApplies = (h) => IDLE_HOSTS.some(k => h === k || h.endsWith('.' + k));

test('idle window is 20 minutes', () => {
  assert.ok(IDLE_MIN, 'IDLE_TIMEOUT_MINUTES must exist in toolConfigs.js');
  assert.strictEqual(IDLE_MIN[1], '20', 'the inactivity window must be 20 minutes');
});

test('(1) HIX AI expires on inactivity', () => {
  assert.strictEqual(idleApplies('hix.ai'), true);
  assert.strictEqual(idleApplies('www.hix.ai'), true);
  assert.strictEqual(idleApplies('app.hix.ai'), true);
});

test('(2) BypassGPT expires on inactivity', () => {
  assert.strictEqual(idleApplies('bypassgpt.ai'), true);
  assert.strictEqual(idleApplies('www.bypassgpt.ai'), true);
});

test('(3) SciSpace does NOT expire on inactivity', () => {
  for (const h of ['scispace.com', 'typeset.io', 'www.scispace.com']) {
    assert.strictEqual(idleApplies(h), false, `${h} must have no inactivity expiry`);
  }
});

test('(4) Claude does NOT expire on inactivity', () => {
  for (const h of ['claude.ai', 'www.claude.ai']) {
    assert.strictEqual(idleApplies(h), false, `${h} must have no inactivity expiry`);
  }
});

test('(5) every other supported tool does NOT expire on inactivity', () => {
  for (const h of ['writehuman.ai', 'ryne.ai', 'grok.com', 'chatgpt.com',
                   'stealthwriter.ai', 'anything-added-later.com']) {
    assert.strictEqual(idleApplies(h), false, `${h} must have no inactivity expiry`);
  }
  assert.deepStrictEqual(IDLE_HOSTS.slice().sort(), ['bypassgpt.ai', 'hix.ai'],
    'the idle list must contain exactly HIX AI and GPT Bypass');
});

test('activity-reset logic is unchanged (timer resets on any interaction)', () => {
  assert.match(BG, /function idleActivityReporter\(/, 'the in-tab interaction reporter must remain');
  assert.match(BG, /setStorage\(\{\s*\[idleKey\(host\)\]:\s*Date\.now\(\)/,
    'an interaction must still stamp the per-host activity key');
  assert.match(BG, /now - last >= limitMs/, 'the expiry comparison must be unchanged');
});

test('PRESERVE: the idle watchdog wiring is intact', () => {
  assert.match(BG, /function idleKey\(/, 'per-host activity key');
  assert.match(BG, /function idleActivityReporter\(/, 'the in-tab interaction reporter');
  assert.match(BG, /async function startIdleWatch\(/, 'watch start');
  assert.match(BG, /async function checkIdleSessions\(/, 'the periodic check');
  assert.match(BG, /chrome\.alarms\.create\(IDLE_ALARM_NAME/, 'alarm-backed so it survives SW sleep');
  assert.match(BG, /IDLE_TIMEOUT_MINUTES/, 'the check must use the configured window');
});

// ── 2. ADMIN / BACKEND ACCESS ENDED ───────────────────────────────────────────
test('PRESERVE: assignment expiry/revocation is terminal, not retried', () => {
  const m = BG.match(/const FINAL_BUSINESS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'FINAL_BUSINESS terminal-code list must exist');
  const codes = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  for (const c of ['assignment_expired', 'assignment_not_found', 'device_blocked',
                   'session_bundle_missing', 'tool_domain_invalid']) {
    assert.ok(codes.includes(c), `${c} must stay a terminal business code`);
  }
});

test('PRESERVE: access ending wipes cookies AND page storage, then redirects', () => {
  assert.match(BG, /async function clearCookiesForConfig\(/, 'cookie wipe');
  assert.match(BG, /async function clearStorageAndRedirectTabs\(/, 'storage wipe + redirect');
  // assignment_expired must map to the access-expired stage the dashboard understands.
  assert.match(BG, /assignment_expired'\)\s*\?\s*'tool_access_expired'/,
    'assignment_expired must still resolve to the tool_access_expired stage');
});

test('PRESERVE: a refresh cannot bypass a revoked state (server re-verifies every fetch)', () => {
  assert.match(BG, /re-verifies the assignment on every fetch/i,
    'the credentials endpoint re-verification contract must remain documented and intact');
});

test('(6) admin/backend revoke still blocks ALL tools, independently of the idle list', () => {
  // reason='blocked' comes ONLY from the cleanup-manifest 403 / device_blocked branch, and it
  // wipes EVERY known tool. It has no relationship to IDLE_TIMEOUT_HOSTS, so narrowing the idle
  // policy cannot weaken (or fix) it. This is what a SciSpace "reason=blocked" screen actually is.
  assert.match(BG, /err\?\.status === 403 \|\| code === 'device_blocked'/,
    'the account-disabled / device-blocked branch must remain');
  assert.match(BG, /for \(const \[toolId, rec\] of Object\.entries\(known\)\)[\s\S]{0,120}'blocked'/,
    'a backend block must still wipe every known tool, not a subset');
  const idleSection = BG.slice(BG.indexOf('async function checkIdleSessions'));
  assert.ok(!/'blocked'/.test(idleSection.slice(0, 900)),
    'the idle path must never emit reason=blocked — those are separate mechanisms');
});

// ── 3. MONTHLY EXPIRY -> RENEWAL ──────────────────────────────────────────────
test('(7) monthly expiry -> renewal is untouched by the idle policy', () => {
  // The renewal path is driven by backend-confirmed assignment state, never by the idle timer.
  const idleSection = BG.slice(BG.indexOf('async function checkIdleSessions'));
  for (const bad of ['endDate', 'renew', 'assignment']) {
    assert.ok(!new RegExp(bad, 'i').test(idleSection.slice(0, 900)),
      `checkIdleSessions must not reference ${bad} — renewal is a separate mechanism`);
  }
  assert.match(read('js/expired.js'), /SUBSCRIPTION\/ASSIGNMENT expired/i,
    'the expired page must still distinguish a subscription expiry from a session expiry');
});

test('PRESERVE: the expired page and its Renew route still exist', () => {
  assert.ok(fs.existsSync(path.join(EXT, 'expired.html')), 'expired.html must exist');
  assert.ok(fs.existsSync(path.join(EXT, 'js', 'expired.js')), 'js/expired.js must exist');
  assert.match(BG, /expired page's "Renew" button points at the right environment/i,
    'the renewal hand-off to the dashboard must remain wired');
});

test('PRESERVE: the extension update gate is untouched', () => {
  assert.match(BG, /extension_update_required/, 'the update-required code must remain');
  assert.match(BG, /minVersion/, 'the minimum-version gate must remain');
});

// ── ISOLATION: the Claude menu policy must not reach any lifecycle path ───────
test('ISOLATION: the Claude menu policy lives only in the shield DOM layer', () => {
  assert.ok(!/menuPolicy/.test(BG),
    'background.js must not reference menuPolicy — it is a shield-layer DOM rule only');
  for (const name of ['menuPolicy', 'menuBlocked', 'sweepMenuPolicy', 'data-genz-menu-blocked']) {
    assert.ok(!new RegExp(name).test(read('js/expired.js')),
      `expired.js must not reference ${name}`);
  }
});

test('ISOLATION: the menu policy cannot touch cookies, storage, leases or sessions', () => {
  const start = SHIELD.indexOf('function sweepMenuPolicy');
  const fn = SHIELD.slice(start, start + 1400);
  for (const bad of ['cookie', 'localStorage', 'sessionStorage', 'chrome.', 'fetch(', 'lease']) {
    assert.ok(!fn.includes(bad),
      `sweepMenuPolicy must not touch ${bad} — it is a DOM visibility rule and nothing more`);
  }
});

test('ISOLATION: shield.js still has no network/credential surface at all', () => {
  for (const bad of ['XMLHttpRequest', 'chrome.cookies', 'chrome.storage']) {
    assert.ok(!SHIELD.includes(bad), `shield.js must not use ${bad}`);
  }
});
