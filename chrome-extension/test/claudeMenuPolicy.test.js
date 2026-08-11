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





test('effort: permitted levels are exactly Low and Medium', () => {
  const re = grabSource('effortAllowSource');
  for (const ok of ['Low', 'Medium']) assert.ok(re.test(ok), `${ok} must be permitted`);
  for (const no of ['High', 'Extra', 'Extra High', 'Max', 'Maximum', 'Ultra', 'Highest']) {
    assert.ok(!re.test(no), `${no} must NOT be permitted`);
  }
});

// ── Engine guards (rewritten for the ancestor-climb implementation) ───────────
// The previous set asserted the old shape: role-based containers, then grouping by immediate
// parentNode. Both are gone, and each had let a real defect ship — roles that never matched, and
// a Max row in its own section escaping a same-parent group of size 1.

test('picker is found by CLIMBING, not by immediate parent', () => {
  assert.match(SHIELD, /function findPicker/, 'findPicker must exist');
  const fn = SHIELD.slice(SHIELD.indexOf('function findPicker'), SHIELD.indexOf('function findPicker') + 900);
  assert.match(fn, /parentElement/, 'it must walk up the tree');
  assert.match(fn, /depth < MAX_CLIMB/, 'the climb must be bounded');
  assert.ok(!/rows\[i\]\.el\.parentNode\s*===/.test(fn),
    'grouping must not depend on rows sharing one parent — that is how Max escaped');
});

test('the climb can never escape a popover into the page', () => {
  const fn = SHIELD.slice(SHIELD.indexOf('function findPicker'), SHIELD.indexOf('function findPicker') + 900);
  assert.match(fn, /textarea,\[contenteditable="true"\]/,
    'a composer in scope means we left the popover and must stop');
  assert.match(fn, /MAX_PICKER_NODES/, 'an oversized subtree is not a picker');
});

test('a container still needs >=2 same-kind rows AND a permitted one', () => {
  const fn = SHIELD.slice(SHIELD.indexOf('function findPicker'), SHIELD.indexOf('function findPicker') + 900);
  assert.match(fn, /rows\.length >= 2/, 'a lone effort word must never qualify');
  assert.match(fn, /info\.allowed/, 'a group with no permitted level must be ignored');
});

test('ZERO FLASH: hiding runs synchronously from an observer, never on a timer', () => {
  assert.match(SHIELD, /function installMenuGuards/, 'the guards must be installable');
  const fn = SHIELD.slice(SHIELD.indexOf('function installMenuGuards'), SHIELD.indexOf('function installMenuGuards') + 1800);
  assert.match(fn, /new MutationObserver/, 'a dedicated observer is required');
  assert.match(fn, /applyMenuPolicy\(n\)/, 'it must apply the policy on the added node');
  assert.ok(!/setTimeout/.test(fn),
    'no timer may sit between the DOM change and the hide — that is what caused the flash');
  assert.match(SHIELD, /installMenuGuards\(\);/,
    'guards must install immediately, not from start() which waits for DOMContentLoaded');
});

test('selection is refused on pointer, mouse AND keyboard', () => {
  const fn = SHIELD.slice(SHIELD.indexOf('function installMenuGuards'), SHIELD.indexOf('function installMenuGuards') + 1800);
  // Assert the REGISTRATION, not merely that the event name appears somewhere: the handler body
  // contains the string 'keydown' for its Enter/Space filter, so a bare includes() stayed green
  // when the listener itself was deleted.
  for (const ev of ['pointerdown', 'mousedown', 'keydown']) {
    assert.ok(
      new RegExp("addEventListener\\('" + ev + "', onSelectCapture, true\\)").test(fn),
      `${ev} must be registered as a capture listener — click alone is not enough`);
  }
  assert.match(fn, /isBlockedSelection/, 'the guard must consult the verified-picker test');
  assert.match(fn, /preventDefault/, 'a blocked row must have its activation cancelled');
});

test('normalisation goes through the app and fires once per container', () => {
  const fn = SHIELD.slice(SHIELD.indexOf('function vetPicker'), SHIELD.indexOf('function vetPicker') + 1400);
  assert.match(fn, /!\s*found\.container\.__genzPolicyFixed/, 'guarded by the flag, not merely setting it');
  assert.match(fn, /__genzPolicyFixed\s*=\s*true/, 'and must record that it fired');
  assert.match(fn, /fallback\.click\(\)/,
    "must use the app's own handler so the composer label and stored preference both update");
});

test('both pickers are governed: effort and model', () => {
  assert.match(SHIELD, /kind: 'effort'/, 'effort vocabulary must exist');
  assert.match(SHIELD, /kind: 'model'/, 'model vocabulary must exist');
  assert.match(SHIELD, /\/fable\/i\.test\(label\)\) allowed = false/,
    'fable must lose in every variant, regardless of the allow pattern');
});

test('model policy keeps Opus/Sonnet/Haiku and blocks every Fable variant', () => {
  const allow = grabSource('modelAllowSource'), word = grabSource('modelWordSource');
  for (const ok of ['Claude Opus 4.5', 'Claude Sonnet 4.5', 'Claude Haiku 4.5']) {
    assert.ok(word.test(ok) && allow.test(ok), `${ok} must be recognised and permitted`);
  }
  for (const no of ['Fable 5', 'claude-fable-5', 'Fable']) {
    assert.ok(word.test(no), `${no} must be recognised`);
    assert.ok(!allow.test(no), `${no} must not be permitted`);
  }
});
