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
test('PRESERVE: idle window is 15 minutes', () => {
  const m = TOOLCFG.match(/export const IDLE_TIMEOUT_MINUTES\s*=\s*(\d+)/);
  assert.ok(m, 'IDLE_TIMEOUT_MINUTES must exist in toolConfigs.js');
  assert.strictEqual(m[1], '15',
    'the idle window is 15 minutes; changing it alters when shared sessions end');
});

test('PRESERVE: idle applies to exactly the four tool hosts — and NOT claude.ai', () => {
  const m = TOOLCFG.match(/export const IDLE_TIMEOUT_HOSTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'IDLE_TIMEOUT_HOSTS must exist');
  const hosts = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepStrictEqual(hosts.sort(), ['bypassgpt.ai', 'hix.ai', 'ryne.ai', 'writehuman.ai']);
  assert.ok(!hosts.includes('claude.ai'),
    'extension Claude has never been in the idle list; adding it would be a behaviour change');
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

// ── 3. MONTHLY EXPIRY -> RENEWAL ──────────────────────────────────────────────
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
