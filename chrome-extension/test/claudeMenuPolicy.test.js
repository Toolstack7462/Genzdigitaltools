/**
 * Claude model/effort menu policy — semantics guard (claude.ai only).
 *
 * The behavioural proof runs in a real browser against a mock Radix picker; this file guards the
 * parts that can regress silently in review: the policy regexes themselves, and the SCOPING that
 * keeps them away from page content.
 *
 * The scoping matters more than the matching. shield.js has a second, page-wide text rule
 * (hideTextSource -> processOne) that runs over every a/button/li/span/div/p/h1-h4 on the page.
 * Putting "High" or "Max" in THAT would blank those words inside a conversation, an artifact or a
 * code block. The menu policy must therefore stay gated on an open menu/listbox popover.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const TOOLCFG = fs.readFileSync(path.join(EXT, 'js', 'config', 'toolConfigs.js'), 'utf8');
const SHIELD = fs.readFileSync(path.join(EXT, 'js', 'shield.js'), 'utf8');

function grabSource(key) {
  const m = TOOLCFG.match(new RegExp(key + ":\\s*'((?:[^'\\\\]|\\\\.)*)'"));
  assert.ok(m, `menuPolicy.${key} not found in toolConfigs.js`);
  return new RegExp(m[1].replace(/\\\\/g, '\\'), 'i');
}
const BLOCK = grabSource('blockSource');
const KEEP = grabSource('keepSource');

// Mirrors shield.js menuBlocked(): keep wins over block.
const blocked = (label) => !KEEP.test(label) && BLOCK.test(label);

test('models: Fable is blocked, Opus / Sonnet / Haiku are kept', () => {
  for (const l of ['Fable 5', 'Claude Fable 5', 'fable-5', 'Fable']) {
    assert.strictEqual(blocked(l), true, `"${l}" must be blocked`);
  }
  for (const l of ['Claude Opus 4.5', 'Claude Sonnet 4.5', 'Claude Haiku 4.5', 'Opus', 'Sonnet', 'Haiku']) {
    assert.strictEqual(blocked(l), false, `"${l}" must be kept`);
  }
});

test('effort: High / Extra / Max blocked, Low / Medium kept', () => {
  for (const l of ['High', 'Extra', 'Extra High', 'Very High', 'Max', 'Maximum', 'Highest', 'Ultra']) {
    assert.strictEqual(blocked(l), true, `"${l}" must be blocked`);
  }
  for (const l of ['Low', 'Medium']) {
    assert.strictEqual(blocked(l), false, `"${l}" must be kept`);
  }
});

test('keep wins: a kept model is never lost to a stray blocked word', () => {
  // e.g. a future "Claude Opus 4.5 — highest quality" row must survive.
  assert.strictEqual(blocked('Claude Opus 4.5 highest quality'), false);
  assert.strictEqual(blocked('Sonnet — max context'), false);
});

test('prose is not matched: blocked words only match as a WHOLE label', () => {
  // These are the shapes that appear in conversation text, not as a picker row label.
  for (const l of ['My high score', 'the max value', 'extra credit', 'highlight', 'maximum effort was needed']) {
    assert.strictEqual(blocked(l), false, `"${l}" is prose and must not match`);
  }
});

test('SCOPING: the menu policy is gated on an open menu container, never page-wide', () => {
  assert.match(SHIELD, /function sweepMenuPolicy/, 'sweepMenuPolicy must exist');
  const fn = SHIELD.slice(SHIELD.indexOf('function sweepMenuPolicy'));
  assert.match(fn.slice(0, 1400), /MENU\.containers/,
    'rows must be selected via the container list, not from the document at large');
  assert.match(fn.slice(0, 1400), /querySelectorAll\(MENU\.items\)/,
    'items must be queried INSIDE a matched container');
});

test('SCOPING: the blocked words are NOT in the page-wide hideTextSource rule', () => {
  const m = TOOLCFG.match(/hideTextSource:\s*'((?:[^'\\]|\\.)*)'/);
  if (!m) return;                       // no default text rule configured at all
  const src = m[1];
  for (const w of ['fable', 'high', 'extra', 'max', 'ultra']) {
    assert.ok(!new RegExp(w, 'i').test(src),
      `"${w}" must not be in hideTextSource — that rule runs over the whole page`);
  }
});

test('SCOPING: only claude.ai carries a menuPolicy', () => {
  const count = (TOOLCFG.match(/menuPolicy:\s*\{/g) || []).length;
  assert.strictEqual(count, 1, 'exactly one menuPolicy must exist');
  // The nearest preceding host key must be claude.ai — i.e. the policy sits in that block.
  const before = TOOLCFG.slice(0, TOOLCFG.indexOf('menuPolicy: {'));
  const hostKeys = before.match(/'[a-z0-9.-]+\.[a-z]{2,}'\s*:/gi) || [];
  const nearest = hostKeys[hostKeys.length - 1] || '';
  assert.match(nearest, /^'claude\.ai'\s*:$/,
    `the menuPolicy must sit inside the claude.ai override block (nearest host key was ${nearest})`);
});

test('the click guard refuses a blocked row, not just hides it', () => {
  assert.match(SHIELD, /function onClickCapture/);
  const fn = SHIELD.slice(SHIELD.indexOf('function onClickCapture'), SHIELD.indexOf('function onClickCapture') + 900);
  assert.match(fn, /menuBlocked\(/, 'the click handler must consult the menu policy');
  assert.match(fn, /preventDefault/, 'a blocked row must have its activation cancelled');
});

test('label extraction is visibility-independent (innerText returns "" once hidden)', () => {
  const fn = SHIELD.slice(SHIELD.indexOf('function menuLabel'), SHIELD.indexOf('function menuLabel') + 700);
  assert.ok(!/innerText/.test(fn),
    'menuLabel must not use innerText: it returns "" for an already-hidden row, which collapsed the ' +
    'label to concatenated textContent and let a click through on a blocked row');
  assert.match(fn, /childNodes/, 'the label must come from the first text-bearing child');
});

// ── Effort picker detected by CONTENT, not by ARIA role ───────────────────────
// The role-based rule above only fires when a row is BOTH inside [role=menu|listbox] AND is
// itself [role=menuitem|option]. Claude's effort control satisfies neither, so Low/Medium/
// High/Max all stayed visible. These guard the content-signature pass that replaced it.
test('effort: the content-signature config exists and is claude-scoped', () => {
  for (const k of ['effortRowSel', 'effortWordSource', 'effortAllowSource']) {
    assert.ok(new RegExp(k + ':').test(TOOLCFG), `menuPolicy.${k} must exist`);
  }
  assert.strictEqual((TOOLCFG.match(/effortRowSel:/g) || []).length, 1,
    'exactly one effort policy, inside the claude.ai override');
});

test('effort: a group is only acted on with >=2 effort siblings AND a permitted one', () => {
  const start = SHIELD.indexOf('function sweepEffortGroups');
  assert.ok(start !== -1, 'sweepEffortGroups must exist');
  const fn = SHIELD.slice(start, start + 2200);
  assert.match(fn, /grp\.length < 2/, 'a lone effort word must never qualify');
  assert.match(fn, /hasAllowed/, 'a group with no permitted level must be ignored');
  assert.match(fn, /EFFORT_ALLOW_RE\.test\(grp\[h\]\.label\)\)\s*\{/,
    'permitted levels must be skipped, never hidden');
});

test('effort: the auto-fallback goes through the app and cannot loop', () => {
  const start = SHIELD.indexOf('function sweepEffortGroups');
  const fn = SHIELD.slice(start, start + 2600);
  // Match the GUARD CONDITION, not merely the flag: asserting on the bare name also matched
  // the assignment, so deleting the condition left the test green while the loop guard was gone.
  assert.match(fn, /!\s*keys\[b\]\.__genzEffortFixed/,
    'the fallback must be guarded by the flag, not merely set it');
  assert.match(fn, /keys\[b\]\.__genzEffortFixed\s*=\s*true/, 'and must record that it fired');
  assert.match(fn, /fallback\.click\(\)/,
    "the fallback must use the app's own handler, not a storage write we don't understand");
  assert.match(fn, /\/\^medium\$\/i/, 'Medium must be preferred as the fallback level');
});

test('effort: permitted levels are exactly Low and Medium', () => {
  const re = grabSource('effortAllowSource');
  for (const ok of ['Low', 'Medium']) assert.ok(re.test(ok), `${ok} must be permitted`);
  for (const no of ['High', 'Extra', 'Extra High', 'Max', 'Maximum', 'Ultra', 'Highest']) {
    assert.ok(!re.test(no), `${no} must NOT be permitted`);
  }
});
