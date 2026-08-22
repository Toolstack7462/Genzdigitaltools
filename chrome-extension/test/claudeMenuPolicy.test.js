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
const { bootShield } = require('./_domHarness.js');

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
  const fn = SHIELD.slice(SHIELD.indexOf('function findPicker'), SHIELD.indexOf('function isSelectedRow'));
  assert.match(fn, /parentElement/, 'it must walk up the tree');
  assert.match(fn, /depth < MAX_CLIMB/, 'the climb must be bounded');
  assert.ok(!/rows\[i\]\.el\.parentNode\s*===/.test(fn),
    'grouping must not depend on rows sharing one parent — that is how Max escaped');
});

test('the climb can never escape a popover into the page', () => {
  const fn = SHIELD.slice(SHIELD.indexOf('function findPicker'), SHIELD.indexOf('function isSelectedRow'));
  assert.match(fn, /textarea,\[contenteditable="true"\]/,
    'a composer in scope means we left the popover and must stop');
  assert.match(fn, /MAX_PICKER_NODES/, 'an oversized subtree is not a picker');
});

test('a container still needs >=2 same-kind rows AND a permitted one', () => {
  const fn = SHIELD.slice(SHIELD.indexOf('function findPicker'), SHIELD.indexOf('function isSelectedRow'));
  assert.match(fn, /rows\.length >= 2/, 'a lone effort word must never qualify');
  assert.match(fn, /info\.allowed/, 'a group with no permitted level must be ignored');
});

test('ZERO FLASH: hiding runs synchronously from an observer, never on a timer', () => {
  assert.match(SHIELD, /function installMenuGuards/, 'the guards must be installable');
  const fn = SHIELD.slice(SHIELD.indexOf('function installMenuGuards'), SHIELD.indexOf('function installMenuGuards') + 2600);
  assert.match(fn, /new MutationObserver/, 'a dedicated observer is required');
  assert.match(fn, /applyMenuPolicy\(n\)/, 'it must apply the policy on the added node');
  assert.ok(!/setTimeout/.test(fn),
    'no timer may sit between the DOM change and the hide — that is what caused the flash');
  assert.match(SHIELD, /installMenuGuards\(\);/,
    'guards must install immediately, not from start() which waits for DOMContentLoaded');
});

test('selection is refused on pointer, mouse AND keyboard', () => {
  const fn = SHIELD.slice(SHIELD.indexOf('function installMenuGuards'), SHIELD.indexOf('function installMenuGuards') + 2600);
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
  const fn = SHIELD.slice(SHIELD.indexOf('function vetPicker'), SHIELD.indexOf('function applyMenuPolicy'));
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

// ═════════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL PROOF — the restrictions actually take effect
// ═════════════════════════════════════════════════════════════════════════════
// Everything above asserts on SOURCE TEXT. Those assertions can stay green while the policy is
// dead in the browser, which is exactly the doubt this section removes: shield.js is executed
// for real, against the genuine shipped claude.ai menuPolicy, on a mock of Claude's pickers.
//
// The Max row deliberately sits in its OWN wrapper — that is the shape which defeated the
// earlier same-parent grouping implementation and let Max survive.

// The menuPolicy is parsed straight out of toolConfigs.js, so this test can never drift from
// what is actually deployed.
function claudeConfig() {
  const i = TOOLCFG.indexOf('menuPolicy: {');
  assert.ok(i !== -1, 'menuPolicy must exist in toolConfigs.js');
  let d = 0, end = i;
  for (let k = TOOLCFG.indexOf('{', i); k < TOOLCFG.length; k++) {
    if (TOOLCFG[k] === '{') d++;
    else if (TOOLCFG[k] === '}') { d--; if (d === 0) { end = k + 1; break; } }
  }
  const body = TOOLCFG.slice(TOOLCFG.indexOf('{', i), end).replace(/\/\/[^\n]*/g, '');
  return {
    enabled: true,
    hrefSubstrings: [], attrSubstrings: [], hideSelectors: [],
    hideTextSource: '^(account|settings|log\\s?out)$',
    keepTextSource: '^(dashboard|home|new chat|chat|send)$',
    blockRouteFragments: [],
    menuPolicy: new Function('return (' + body + ')')(),
  };
}

function buildClaude(d) {
  // Effort picker — Max in its own wrapper (the historic escape route).
  const effort = d.el('div', { role: 'menu' }, [
    d.el('button', { role: 'menuitem' }, ['Low']),
    d.el('button', { role: 'menuitem', 'aria-checked': 'true' }, ['Medium']),
    d.el('button', { role: 'menuitem' }, ['High']),
    d.el('div', {}, [d.el('button', { role: 'menuitem' }, ['Max'])]),
  ]);
  // Model picker — name and description are SIBLINGS, which is why menuLabel reads the first
  // text-bearing child instead of the whole textContent.
  const models = d.el('div', { role: 'menu' }, [
    d.el('button', { role: 'menuitem' }, [d.el('span', {}, ['Claude Opus 4.5']), d.el('span', {}, ['Most capable'])]),
    d.el('button', { role: 'menuitem', 'aria-checked': 'true' }, [d.el('span', {}, ['Claude Sonnet 4.5']), d.el('span', {}, ['Balanced'])]),
    d.el('button', { role: 'menuitem' }, [d.el('span', {}, ['Fable 5']), d.el('span', {}, ['Fastest for everyday tasks'])]),
  ]);
  const convo = d.el('div', {}, ['My high score was the max value, extra credit.']);
  d.body.appendChild(d.el('div', {}, [effort, models, convo]));
  return { effort, models, convo };
}
const rowByLabel = (root, label) =>
  root.querySelectorAll('button').find((b) => (b.textContent || '').startsWith(label));

test('BEHAVIOUR: High and Max are removed from the effort picker; Low and Medium remain', () => {
  const t = bootShield(buildClaude, claudeConfig());
  assert.strictEqual(rowByLabel(t.effort, 'Low').hidden, false, 'Low must remain');
  assert.strictEqual(rowByLabel(t.effort, 'Medium').hidden, false, 'Medium must remain');
  assert.strictEqual(rowByLabel(t.effort, 'High').hidden, true, 'High must be removed');
  assert.strictEqual(rowByLabel(t.effort, 'Max').hidden, true,
    'Max must be removed even though it sits in its own wrapper');
});

test('BEHAVIOUR: Fable 5 is removed from the model picker; Opus and Sonnet remain', () => {
  const t = bootShield(buildClaude, claudeConfig());
  assert.strictEqual(rowByLabel(t.models, 'Claude Opus 4.5').hidden, false, 'Opus must remain');
  assert.strictEqual(rowByLabel(t.models, 'Claude Sonnet 4.5').hidden, false, 'Sonnet must remain');
  assert.strictEqual(rowByLabel(t.models, 'Fable 5').hidden, true, 'Fable 5 must be removed');
});

test('BEHAVIOUR: a blocked row cannot be activated by pointer, mouse, click, Enter or Space', () => {
  for (const label of ['High', 'Max']) {
    for (const [type, extra] of [['pointerdown'], ['mousedown'], ['click'],
                                 ['keydown', { key: 'Enter' }], ['keydown', { key: ' ' }]]) {
      const t = bootShield(buildClaude, claudeConfig());
      const ev = t.doc._dispatch(type, rowByLabel(t.effort, label), extra);
      assert.strictEqual(ev.defaultPrevented, true,
        type + ' on "' + label + '" must be refused, not merely hidden');
    }
  }
  const t = bootShield(buildClaude, claudeConfig());
  const ev = t.doc._dispatch('click', rowByLabel(t.models, 'Fable 5'));
  assert.strictEqual(ev.defaultPrevented, true, 'Fable 5 must be unselectable');
});

test('BEHAVIOUR: permitted rows stay fully selectable', () => {
  const t = bootShield(buildClaude, claudeConfig());
  for (const pair of [[t.effort, 'Low'], [t.effort, 'Medium'],
                      [t.models, 'Claude Opus 4.5'], [t.models, 'Claude Sonnet 4.5']]) {
    const ev = t.doc._dispatch('click', rowByLabel(pair[0], pair[1]));
    assert.strictEqual(ev.defaultPrevented, false, pair[1] + ' must remain selectable');
  }
});

test('BEHAVIOUR: conversation prose containing high/max/extra is never touched', () => {
  const t = bootShield(buildClaude, claudeConfig());
  assert.strictEqual(t.convo.hidden, false, 'the message must stay visible');
  assert.strictEqual(t.convo.textContent, 'My high score was the max value, extra credit.');
});

test('BEHAVIOUR: a re-rendered picker is re-vetted (React recreation restores nothing)', () => {
  const t = bootShield(buildClaude, claudeConfig());
  const fresh = t.doc.el('div', { role: 'menu' }, [
    t.doc.el('button', { role: 'menuitem', 'aria-checked': 'true' }, ['Medium']),
    t.doc.el('button', { role: 'menuitem' }, ['High']),
  ]);
  t.doc.body.appendChild(t.doc.el('div', {}, [fresh]));
  t.doc._mutate([fresh]);
  assert.strictEqual(rowByLabel(fresh, 'High').hidden, true, 'the recreated High must be removed');
  assert.strictEqual(t.doc._dispatch('click', rowByLabel(fresh, 'High')).defaultPrevented, true);
});

test('BEHAVIOUR: a conversation already pinned to a blocked level is normalised to Medium', () => {
  const t = bootShield(function (d) {
    const effort = d.el('div', { role: 'menu' }, [
      d.el('button', { role: 'menuitem' }, ['Low']),
      d.el('button', { role: 'menuitem' }, ['Medium']),
      d.el('button', { role: 'menuitem', 'aria-checked': 'true' }, ['High']),   // blocked + selected
    ]);
    d.body.appendChild(d.el('div', {}, [effort]));
    return { effort };
  }, claudeConfig());
  assert.strictEqual(rowByLabel(t.effort, 'Medium').clicks, 1,
    'the permitted fallback must be chosen through the app own handler');
});

test('BEHAVIOUR: the Claude policy is independent of the ChatGPT tab policy', () => {
  const cfg = claudeConfig();
  assert.ok(!cfg.tabPolicy, 'claude.ai must never receive the ChatGPT tab policy');
  const t = bootShield(buildClaude, cfg);
  assert.strictEqual(rowByLabel(t.effort, 'High').hidden, true,
    'the ChatGPT Work work must not have coupled or disabled this feature');
});

// ═════════════════════════════════════════════════════════════════════════════
// REPORTED DEFECT: "Sonnet and Max mode is selected and I can't change it"
// ═════════════════════════════════════════════════════════════════════════════
// Three independent reasons Max survived in the real UI, each reproduced here. The mock used by
// the section above (a detached [role=menu] popover with aria-checked) passed the whole time,
// which is precisely why the failure was invisible to the suite.

test('DEFECT 1: a picker rendered BESIDE the composer is still found', () => {
  // findPicker used to return null the instant a composer was in scope, so a mode control that
  // lives in the composer cluster could never be detected — no row was ever even classified.
  const t = bootShield(function (d) {
    const effort = d.el('div', {}, [
      d.el('button', {}, ['Low']),
      d.el('button', { 'aria-pressed': 'true' }, ['Medium']),
      d.el('button', {}, ['High']),
      d.el('button', {}, ['Max']),
    ]);
    const composer = d.el('div', {}, [effort, d.el('textarea', {}, [])]);
    d.body.appendChild(d.el('div', {}, [composer]));
    return { effort };
  }, claudeConfig());
  assert.strictEqual(rowByLabel(t.effort, 'High').hidden, true, 'High must be removed');
  assert.strictEqual(rowByLabel(t.effort, 'Max').hidden, true,
    'Max must be removed even though the composer is in scope');
  assert.strictEqual(rowByLabel(t.effort, 'Low').hidden, false, 'Low stays');
  assert.strictEqual(rowByLabel(t.effort, 'Medium').hidden, false, 'Medium stays');
});

test('DEFECT 1b: the app SHELL is still refused even though it holds a composer', () => {
  // Relaxing the composer rule must not let the climb escape into the page. A big container is
  // still disqualified, so nothing structural can ever be treated as a picker.
  const t = bootShield(function (d) {
    const kids = [d.el('button', {}, ['Low']), d.el('button', {}, ['Max']), d.el('textarea', {}, [])];
    for (let i = 0; i < 120; i++) kids.push(d.el('span', {}, ['x']));
    const shell = d.el('div', {}, kids);
    d.body.appendChild(d.el('div', {}, [shell]));
    return { shell };
  }, claudeConfig());
  assert.strictEqual(t.shell.hidden, false, 'the shell must never be hidden');
  assert.strictEqual(rowByLabel(t.shell, 'Max').hidden, false,
    'an oversized composer container is not a picker, so nothing is touched');
});

test('DEFECT 2: selection is recognised via aria-pressed / aria-current / data-active', () => {
  for (const attrs of [{ 'aria-pressed': 'true' }, { 'aria-current': 'true' },
                       { 'data-active': 'true' }, { 'data-selected': 'true' }]) {
    const t = bootShield(function (d) {
      const effort = d.el('div', { role: 'menu' }, [
        d.el('button', { role: 'menuitem' }, ['Low']),
        d.el('button', { role: 'menuitem' }, ['Medium']),
        d.el('button', Object.assign({ role: 'menuitem' }, attrs), ['Max']),   // pinned to Max
      ]);
      d.body.appendChild(d.el('div', {}, [effort]));
      return { effort };
    }, claudeConfig());
    assert.strictEqual(rowByLabel(t.effort, 'Medium').clicks, 1,
      'a Max selection marked with ' + JSON.stringify(attrs) + ' must be normalised to Medium');
  }
});

test('DEFECT 3: Max pinned with UNRECOGNISED markup is still normalised to Medium', () => {
  // The decisive fix. Repair used to require positive proof that a BLOCKED row was selected. If
  // Claude marks its active row in a way we do not recognise, that proof never arrived, nothing
  // was repaired, and the conversation stayed on Max — the exact reported symptom.
  const t = bootShield(function (d) {
    const effort = d.el('div', { role: 'menu' }, [
      d.el('button', { role: 'menuitem' }, ['Low']),
      d.el('button', { role: 'menuitem' }, ['Medium']),
      d.el('button', { role: 'menuitem', 'data-mystery-state': 'on' }, ['Max']),
    ]);
    d.body.appendChild(d.el('div', {}, [effort]));
    return { effort };
  }, claudeConfig());
  assert.strictEqual(rowByLabel(t.effort, 'Max').hidden, true, 'Max is removed');
  assert.strictEqual(rowByLabel(t.effort, 'Medium').clicks, 1,
    'and the permitted fallback is asserted through the app own handler');
});

test('a picker already on a PERMITTED level is left alone', () => {
  const t = bootShield(function (d) {
    const effort = d.el('div', { role: 'menu' }, [
      d.el('button', { role: 'menuitem', 'aria-checked': 'true' }, ['Low']),
      d.el('button', { role: 'menuitem' }, ['Medium']),
      d.el('button', { role: 'menuitem' }, ['Max']),
    ]);
    d.body.appendChild(d.el('div', {}, [effort]));
    return { effort };
  }, claudeConfig());
  assert.strictEqual(rowByLabel(t.effort, 'Medium').clicks, 0,
    'Low is permitted and detectably selected, so nothing may be changed');
  assert.strictEqual(rowByLabel(t.effort, 'Max').hidden, true, 'Max is still removed');
});

test('repair fires at most once per picker instance (no click loop)', () => {
  const t = bootShield(function (d) {
    const effort = d.el('div', { role: 'menu' }, [
      d.el('button', { role: 'menuitem' }, ['Medium']),
      d.el('button', { role: 'menuitem' }, ['Max']),
    ]);
    d.body.appendChild(d.el('div', {}, [effort]));
    return { effort };
  }, claudeConfig());
  for (let i = 0; i < 8; i++) t.doc._mutate([t.effort]);
  assert.strictEqual(rowByLabel(t.effort, 'Medium').clicks, 1,
    'the guard flag must keep this to a single activation');
});

test('the model picker is normalised off a blocked model the same way', () => {
  const t = bootShield(function (d) {
    const models = d.el('div', { role: 'menu' }, [
      d.el('button', { role: 'menuitem' }, [d.el('span', {}, ['Claude Sonnet 4.5'])]),
      d.el('button', { role: 'menuitem' }, [d.el('span', {}, ['Fable 5'])]),
    ]);
    d.body.appendChild(d.el('div', {}, [models]));
    return { models };
  }, claudeConfig());
  assert.strictEqual(rowByLabel(t.models, 'Fable 5').hidden, true);
  assert.strictEqual(rowByLabel(t.models, 'Claude Sonnet 4.5').clicks, 1,
    'a Fable selection must fall back to Sonnet');
});

test('prose beside a composer still cannot be mistaken for a picker', () => {
  // The composer relaxation must not open a false-positive path into message content.
  const t = bootShield(function (d) {
    const msg = d.el('div', {}, ['Use max effort and high quality for this task.']);
    const wrap = d.el('div', {}, [msg, d.el('textarea', {}, [])]);
    d.body.appendChild(d.el('div', {}, [wrap]));
    return { msg, wrap };
  }, claudeConfig());
  assert.strictEqual(t.msg.hidden, false, 'a message must never be hidden');
  assert.strictEqual(t.msg.textContent, 'Use max effort and high quality for this task.');
  assert.strictEqual(t.wrap.hidden, false);
});
