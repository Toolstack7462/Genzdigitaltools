/**
 * ChatGPT "Chat / Work" mode-switcher policy — chatgpt.com ONLY.
 *
 * Two layers of proof:
 *
 *  1. BEHAVIOURAL. shield.js is executed for real, in a node:vm realm, against a minimal DOM
 *     harness built in this file (no new dependency, no second test framework). The actual
 *     policy code runs: the observer fires, the capture guards refuse events, the recovery
 *     click goes through the app's own handler. This is what proves Work is INERT rather than
 *     merely invisible.
 *
 *  2. SCOPING. Source-text assertions in the style of claudeMenuPolicy.test.js, guarding the
 *     parts that regress silently in review: that "work" never leaks into the page-wide
 *     hideTextSource rule, and that no tool other than chatgpt.com can receive a tabPolicy.
 *
 * The harness is deliberately small and strict: a selector it cannot parse matches NOTHING,
 * so a harness gap can only ever make a test fail, never make it falsely pass.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..');
const SHIELD_SRC = fs.readFileSync(path.join(EXT, 'js', 'shield.js'), 'utf8');
const TOOLCFG = fs.readFileSync(path.join(EXT, 'js', 'config', 'toolConfigs.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Minimal DOM harness
// ─────────────────────────────────────────────────────────────────────────────
// Supports exactly the operations shield.js performs. Selector support: comma lists of
// `tag`, `[attr]`, `[attr="v"]`, `[attr*="v"]` (with optional ` i`), and `tag[attr]`.
// Anything else (`.class`, `:has()`) is UNPARSEABLE BY DESIGN and matches nothing.

const PART_RE = /^([a-zA-Z][\w-]*|\*)?((?:\[\s*[\w:-]+\s*(?:[~|^$*]?=\s*"[^"]*"\s*i?)?\s*\])*)$/;
const ATTR_RE = /\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*"([^"]*)"\s*(i)?)?\s*\]/g;

function parseSel(sel) {
  const out = [];
  for (const raw of String(sel).split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = PART_RE.exec(part);
    if (!m) continue;                       // unparseable → matches nothing
    const tag = m[1] && m[1] !== '*' ? m[1].toUpperCase() : null;
    const anyTag = m[1] === '*';
    const attrs = [];
    ATTR_RE.lastIndex = 0;
    let a;
    while ((a = ATTR_RE.exec(m[2] || ''))) {
      attrs.push({ name: a[1], op: a[2] || null, val: a[3], ci: !!a[4] });
    }
    if (!tag && !anyTag && !attrs.length) continue;
    out.push({ tag, anyTag, attrs });
  }
  return out;
}
function matchPart(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  for (const at of c.attrs) {
    let v = el.getAttribute(at.name);
    if (v === null || v === undefined) return false;
    v = String(v);
    let want = at.val;
    if (at.ci) { v = v.toLowerCase(); want = String(want).toLowerCase(); }
    if (at.op === '=' && v !== want) return false;
    if (at.op === '*=' && v.indexOf(want) === -1) return false;
    if (at.op === '^=' && v.indexOf(want) !== 0) return false;
  }
  return true;
}
const matchSel = (el, parsed) => parsed.some((c) => matchPart(el, c));

class TextNode {
  constructor(v) { this.nodeType = 3; this.nodeValue = v; }
  get textContent() { return this.nodeValue; }
}
class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentElement = null;
    this._attrs = Object.create(null);
    this._styles = Object.create(null);
    this.clicks = 0;
    const self = this;
    this.style = {
      setProperty(k, v) { self._styles[k] = v; },
      getPropertyValue(k) { return self._styles[k] || ''; },
      get display() { return self._styles.display || ''; },
      set display(v) { self._styles.display = v; }
    };
  }
  get className() { return this._attrs.class || ''; }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  removeAttribute(k) { delete this._attrs[k]; }
  appendChild(c) { c.parentElement = this; this.childNodes.push(c); return c; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  _walk(acc) {
    for (const c of this.childNodes) {
      if (c.nodeType === 1) { acc.push(c); c._walk(acc); }
    }
    return acc;
  }
  getElementsByTagName() { return this._walk([]); }        // only ever called with '*'
  querySelectorAll(sel) {
    const p = parseSel(sel);
    return this._walk([]).filter((e) => matchSel(e, p));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return matchSel(this, parseSel(sel)); }
  closest(sel) {
    const p = parseSel(sel);
    let n = this;
    while (n) { if (n.nodeType === 1 && matchSel(n, p)) return n; n = n.parentElement; }
    return null;
  }
  contains(o) { let n = o; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
  get hidden() {
    let n = this;
    while (n) { if (n._styles.display === 'none') return true; n = n.parentElement; }
    return false;
  }
  click() { this._doc._dispatch('click', this); }
  addEventListener() {}
}

function makeDom() {
  const listeners = [];           // {type, fn, capture}
  const observers = [];           // {cb, opts}
  const doc = {
    nodeType: 9,
    readyState: 'complete',
    createElement(tag) { const e = new El(tag); e._doc = doc; return e; },
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener() {},
    getElementById(id) {
      return doc.documentElement.querySelectorAll('[id]').find((e) => e.getAttribute('id') === id) || null;
    },
    querySelectorAll(s) { return doc.documentElement.querySelectorAll(s); },
    querySelector(s) { return doc.documentElement.querySelector(s); },
    _listeners: listeners,
    _observers: observers,
    // The app's own behaviour: a click that is NOT prevented switches mode.
    app: { mode: 'chat' }
  };
  doc.documentElement = doc.createElement('html');
  doc.documentElement.style.overflow = '';
  doc.head = doc.createElement('head');
  doc.body = doc.createElement('body');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  doc.el = (tag, attrs, kids) => {
    const e = doc.createElement(tag);
    for (const k in (attrs || {})) e.setAttribute(k, attrs[k]);
    for (const c of (kids || [])) e.appendChild(typeof c === 'string' ? new TextNode(c) : c);
    return e;
  };

  // Event dispatch: capture listeners first (in registration order), then the app handler
  // unless the event was prevented.
  doc._dispatch = (type, target, extra) => {
    const ev = Object.assign({
      type, target, defaultPrevented: false, _stopImmediate: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      stopImmediatePropagation() { this._stopImmediate = true; }
    }, extra || {});
    for (const l of listeners) {
      if (l.type !== type) continue;
      l.fn(ev);
      if (ev._stopImmediate) break;
    }
    if (!ev.defaultPrevented) {
      // Simulate ChatGPT: activating a segment selects it and switches mode.
      const seg = target && target.closest
        ? target.closest('[role="tab"],[role="radio"],button')
        : null;
      if (seg) {
        seg.clicks++;
        const label = (seg.textContent || '').trim().toLowerCase();
        if (label === 'chat' || label === 'work') {
          doc.app.mode = label;
          const group = seg.parentElement;
          if (group) {
            for (const s of group.querySelectorAll('[role="tab"],[role="radio"],button')) {
              s.setAttribute('aria-selected', s === seg ? 'true' : 'false');
            }
          }
        }
      }
    }
    return ev;
  };
  // Fire the MutationObserver callbacks the way the browser would: synchronously, pre-paint.
  doc._mutate = (addedNodes, attrTargets) => {
    const recs = [];
    for (const n of (addedNodes || [])) recs.push({ type: 'childList', addedNodes: [n], target: n });
    for (const t of (attrTargets || [])) recs.push({ type: 'attributes', addedNodes: [], target: t });
    for (const o of observers) o.cb(recs);
  };

  class MutationObserver {
    constructor(cb) { this.cb = cb; }
    observe(_t, opts) { observers.push({ cb: this.cb, opts }); }
    disconnect() {}
  }

  const winListeners = [];
  const win = {
    addEventListener(type, fn) { winListeners.push({ type, fn }); },
    removeEventListener() {}
  };
  doc._winListeners = winListeners;
  // Real (manually pumped) timers. shield.js debounces its account/logout sweep through
  // setTimeout(flush, 150); stubbing it to a no-op silently disabled that whole layer in tests.
  // doc._runTimers() stands in for the event loop. setInterval (the 4s safety net) is
  // deliberately NOT pumped — nothing should depend on it.
  const timers = [];
  doc._runTimers = () => { const due = timers.splice(0); for (const f of due) f(); };

  const ctx = vm.createContext({
    window: win,
    document: doc,
    MutationObserver,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    history: { pushState() {}, replaceState() {} },
    location: { pathname: '/', href: 'https://chatgpt.com/', host: 'chatgpt.com' },
    console
  });
  return { doc, win, ctx };
}

// The real, host-resolved ChatGPT config shape (mirrors SHIELD_OVERRIDES['chatgpt.com']).
const CHATGPT_CFG = {
  enabled: true,
  hrefSubstrings: [], attrSubstrings: [], hideSelectors: [],
  hideTextSource: '^(account|settings|log\\s?out)$',
  keepTextSource: '^(chat|new chat|send)$',
  blockRouteFragments: ['/logout', '/account'],
  tabPolicy: {
    rowSel: '[role="tab"],[role="radio"],[role="menuitemradio"],[role="option"],button,a[href],[tabindex]',
    blockLabelSource: '^work$',
    allowLabelSource: '^chat$',
    excludeHrefSource: '/c/|/g/|/gpts|/project|/codex',
    maxLabel: 12,
    maxClimb: 6,
    maxSwitchNodes: 120,
    requireSelectionMarker: true,
    maxRecoveries: 3
  }
};

function boot(buildFn, cfg) {
  const { doc, win, ctx } = makeDom();
  const built = buildFn ? buildFn(doc) : {};
  win.__GENZ_SHIELD_CFG__ = JSON.parse(JSON.stringify(cfg || CHATGPT_CFG));
  vm.runInContext(SHIELD_SRC, ctx);
  return { doc, win, ctx, ...built };
}

// A realistic extension-managed ChatGPT page: the Chat/Work switcher, a composer, a
// conversation containing the word "work", and a sidebar of conversations.
function buildChatGpt(doc, opts) {
  const o = opts || {};
  const switcher = doc.el('div', { role: 'tablist' }, [
    doc.el('button', { role: 'tab', 'aria-selected': o.workActive ? 'false' : 'true' }, [doc.el('span', {}, ['Chat'])]),
    doc.el('button', { role: 'tab', 'aria-selected': o.workActive ? 'true' : 'false' }, [doc.el('span', {}, ['Work'])])
  ]);
  if (o.extraControl) switcher.appendChild(doc.el('button', {}, ['New chat']));

  const sidebar = doc.el('nav', {}, [
    doc.el('a', { href: '/c/aaa' }, ['Work']),              // a conversation TITLED exactly "Work"
    doc.el('a', { href: '/c/bbb' }, ['Chat']),              // and one titled exactly "Chat"
    doc.el('a', { href: '/c/ccc' }, ['Work notes Q3'])
  ]);

  const userMsg = doc.el('div', {}, ['Work is important for my project.']);
  const asstMsg = doc.el('div', {}, ['Sure — here is how Work mode differs from Chat mode.']);
  const codeBlock = doc.el('pre', {}, ['const work = doTheWork();']);
  const composer = doc.el('textarea', { id: 'prompt' }, []);
  const unrelated = doc.el('button', {}, ['Workspace settings']);

  const main = doc.el('main', {}, [userMsg, asstMsg, codeBlock, composer, unrelated]);
  const root = doc.el('div', {}, [switcher, sidebar, main]);
  doc.body.appendChild(root);

  const chatTab = switcher.children[0];
  const workTab = switcher.children[1];
  return { switcher, chatTab, workTab, sidebar, userMsg, asstMsg, codeBlock, composer, unrelated, root };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Harness self-check — a broken harness must not silently pass everything
// ─────────────────────────────────────────────────────────────────────────────
test('harness: selectors, labels and event dispatch behave', () => {
  const { doc } = makeDom();
  const b = doc.el('button', { role: 'tab' }, [doc.el('span', {}, ['Work'])]);
  doc.body.appendChild(b);
  assert.strictEqual(doc.body.querySelectorAll('[role="tab"]').length, 1);
  assert.strictEqual(doc.body.querySelectorAll('button').length, 1);
  assert.strictEqual(b.textContent, 'Work');
  assert.strictEqual(b.closest('[role="tab"]'), b);
  assert.strictEqual(doc.body.querySelectorAll('.some-class').length, 0, 'unparseable selectors match nothing');
  doc._dispatch('click', b);
  assert.strictEqual(b.clicks, 1, 'an unprevented click must reach the app handler');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. UI removal + the visual result
// ─────────────────────────────────────────────────────────────────────────────
test('the Chat/Work switcher is identified and Work is removed on first render', () => {
  const t = boot(buildChatGpt);
  assert.strictEqual(t.workTab.getAttribute('data-genz-tab-blocked') === '1' || t.switcher.hidden, true,
    'Work must be suppressed');
  assert.strictEqual(t.workTab.hidden, true, 'the Work segment must not be visible');
});

test('PREFERRED RESULT: a switcher holding only Chat and Work is removed whole', () => {
  const t = boot(buildChatGpt);
  assert.strictEqual(t.switcher.getAttribute('data-genz-tab-blocked'), '1',
    'the whole container must go — a one-item segmented pill is the broken-looking outcome');
  assert.strictEqual(t.switcher.hidden, true);
  assert.strictEqual(t.switcher.style.getPropertyValue('display'), 'none',
    'no empty Work slot or leftover width may remain');
});

test('SAFE FALLBACK: a container with unrelated controls keeps the container, drops only Work', () => {
  const t = boot((d) => buildChatGpt(d, { extraControl: true }));
  assert.strictEqual(t.switcher.getAttribute('data-genz-tab-blocked'), null,
    'the container carries another control, so removing it would take that control with it');
  assert.strictEqual(t.switcher.hidden, false, 'the container itself must stay');
  assert.strictEqual(t.workTab.hidden, true, 'only the Work segment is removed');
  assert.strictEqual(t.chatTab.hidden, false, 'Chat stays');
});

test('accessibility + focus order: the removed Work segment is out of both', () => {
  const t = boot((d) => buildChatGpt(d, { extraControl: true }));
  assert.strictEqual(t.workTab.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(t.workTab.getAttribute('tabindex'), '-1');
  assert.strictEqual(t.chatTab.getAttribute('aria-hidden'), null, 'Chat must keep normal semantics');
  assert.strictEqual(t.chatTab.getAttribute('tabindex'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Selector safety — the whole point of not text-matching "Work" globally
// ─────────────────────────────────────────────────────────────────────────────
test('conversation content containing "Work" is untouched', () => {
  const t = boot(buildChatGpt);
  assert.strictEqual(t.userMsg.hidden, false, 'a user message containing "Work" must remain visible');
  assert.strictEqual(t.userMsg.textContent, 'Work is important for my project.', 'and unmodified');
  assert.strictEqual(t.asstMsg.hidden, false, 'an assistant response mentioning Work must remain visible');
  assert.strictEqual(t.codeBlock.hidden, false, 'code containing "work" must remain visible');
  assert.strictEqual(t.codeBlock.textContent, 'const work = doTheWork();');
});

test('a sidebar conversation TITLED exactly "Work" is never treated as a mode segment', () => {
  const t = boot(buildChatGpt);
  for (const a of t.sidebar.children) {
    assert.strictEqual(a.hidden, false, `sidebar entry "${a.textContent}" must stay visible`);
    assert.strictEqual(a.getAttribute('data-genz-tab-blocked'), null);
  }
});

test('a conversation titled "Work" next to one titled "Chat" cannot form a fake switcher', () => {
  // The dangerous shape: the excludeHref rule is what defeats it, so prove it in isolation
  // with NO real switcher anywhere on the page.
  const t = boot((d) => {
    const nav = d.el('nav', {}, [
      d.el('a', { href: '/c/aaa', 'aria-current': 'page' }, ['Work']),
      d.el('a', { href: '/c/bbb' }, ['Chat'])
    ]);
    d.body.appendChild(nav);
    return { nav };
  });
  assert.strictEqual(t.nav.children[0].hidden, false, 'the "Work" conversation must survive');
  assert.strictEqual(t.nav.children[1].hidden, false);
  assert.strictEqual(t.nav.hidden, false, 'and the sidebar itself must never be removed');
});

test('an unrelated button with work-related wording stays usable', () => {
  const t = boot(buildChatGpt);
  assert.strictEqual(t.unrelated.hidden, false, '"Workspace settings" is not the label "Work"');
  t.doc._dispatch('click', t.unrelated);
  assert.strictEqual(t.unrelated.clicks, 1, 'and it must still activate');
});

test('the composer is never touched', () => {
  const t = boot(buildChatGpt);
  assert.strictEqual(t.composer.hidden, false);
  assert.strictEqual(t.composer.getAttribute('data-genz-tab-blocked'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Interaction protection — Work must be INERT, not merely invisible
// ─────────────────────────────────────────────────────────────────────────────
for (const evt of ['pointerdown', 'mousedown', 'click']) {
  test(`Work cannot be activated with ${evt}`, () => {
    const t = boot((d) => buildChatGpt(d, { extraControl: true }));
    const ev = t.doc._dispatch(evt, t.workTab);
    assert.strictEqual(ev.defaultPrevented, true, `${evt} on Work must be cancelled`);
    assert.strictEqual(t.workTab.clicks, 0, 'the app handler must never see it');
    assert.strictEqual(t.doc.app.mode, 'chat', 'mode must stay Chat');
  });
}

for (const key of ['Enter', ' ']) {
  test(`Work cannot be activated with ${key === ' ' ? 'Space' : 'Enter'}`, () => {
    const t = boot((d) => buildChatGpt(d, { extraControl: true }));
    const ev = t.doc._dispatch('keydown', t.workTab, { key });
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(t.doc.app.mode, 'chat');
  });
}

test('a click on a CHILD of the Work segment is refused too', () => {
  const t = boot((d) => buildChatGpt(d, { extraControl: true }));
  const inner = t.workTab.children[0];               // the <span>Work</span>
  const ev = t.doc._dispatch('click', inner);
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(t.doc.app.mode, 'chat');
});

test('programmatic .click() on Work does not leave the user in Work', () => {
  const t = boot((d) => buildChatGpt(d, { extraControl: true }));
  t.workTab.click();
  assert.strictEqual(t.doc.app.mode, 'chat', 'the capture guard refuses the synthetic activation too');
});

test('Chat remains fully activatable by pointer and keyboard', () => {
  const t = boot((d) => buildChatGpt(d, { extraControl: true, workActive: false }));
  const ev = t.doc._dispatch('click', t.chatTab);
  assert.strictEqual(ev.defaultPrevented, false, 'Chat must never be blocked');
  assert.strictEqual(t.doc.app.mode, 'chat');
  const kev = t.doc._dispatch('keydown', t.chatTab, { key: 'Enter' });
  assert.strictEqual(kev.defaultPrevented, false, 'Chat must stay keyboard accessible');
});

test('unrelated keys are not swallowed — normal typing still works', () => {
  const t = boot(buildChatGpt);
  const ev = t.doc._dispatch('keydown', t.composer, { key: 'a' });
  assert.strictEqual(ev.defaultPrevented, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. State recovery — landing in Work returns to Chat, without knowing the route
// ─────────────────────────────────────────────────────────────────────────────
test('a session that loads ALREADY in Work is returned to Chat via the app\'s own Chat control', () => {
  const t = boot((d) => buildChatGpt(d, { workActive: true }));
  assert.strictEqual(t.chatTab.clicks, 1, 'the Chat segment must be activated through the app');
  assert.strictEqual(t.doc.app.mode, 'chat', 'the session must end up in Chat');
});

test('recovery is bounded — it cannot become a rerender/redirect loop', () => {
  const t = boot((d) => buildChatGpt(d, { workActive: true }));
  const before = t.chatTab.clicks;
  for (let i = 0; i < 12; i++) {
    t.workTab.setAttribute('aria-selected', 'true');
    t.chatTab.setAttribute('aria-selected', 'false');
    t.doc._mutate([], [t.workTab]);
  }
  assert.ok(t.chatTab.clicks - before <= 3,
    `recovery must be capped by maxRecoveries (saw ${t.chatTab.clicks - before} extra activations)`);
});

test('no recovery is attempted when Chat is already active', () => {
  const t = boot(buildChatGpt);
  assert.strictEqual(t.chatTab.clicks, 0, 'a healthy Chat session must not be clicked at all');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Rerender / SPA lifecycle
// ─────────────────────────────────────────────────────────────────────────────
test('React recreating the switcher does not restore access', () => {
  const t = boot(buildChatGpt);
  // Simulate a rerender: a brand-new switcher subtree is inserted.
  const fresh = t.doc.el('div', { role: 'tablist' }, [
    t.doc.el('button', { role: 'tab', 'aria-selected': 'true' }, ['Chat']),
    t.doc.el('button', { role: 'tab', 'aria-selected': 'false' }, ['Work'])
  ]);
  t.doc.body.appendChild(t.doc.el('div', {}, [fresh]));   // real apps nest it, never body > tablist
  t.doc._mutate([fresh]);
  assert.strictEqual(fresh.hidden, true, 'the recreated switcher must be suppressed again');
  const freshWork = fresh.children[1];
  const ev = t.doc._dispatch('click', freshWork);
  assert.strictEqual(ev.defaultPrevented, true, 'and the recreated Work must still be inert');
});

test('a rerender that flips Work to selected is corrected', () => {
  const t = boot((d) => buildChatGpt(d, { extraControl: true }));
  t.workTab.setAttribute('aria-selected', 'true');
  t.chatTab.setAttribute('aria-selected', 'false');
  t.doc._mutate([], [t.workTab]);
  assert.strictEqual(t.doc.app.mode, 'chat', 'the app must be put back into Chat');
});

test('repeated application is idempotent and installs no duplicate listeners/observers', () => {
  const t = boot(buildChatGpt);
  const listeners0 = t.doc._listeners.length;
  const observers0 = t.doc._observers.length;
  for (let i = 0; i < 5; i++) t.doc._mutate([t.switcher]);
  assert.strictEqual(t.doc._listeners.length, listeners0, 'no listener may be added per pass');
  assert.strictEqual(t.doc._observers.length, observers0, 'no observer may be added per pass');
  assert.strictEqual(t.switcher.hidden, true, 'and the result is unchanged');
});

test('re-injection (SPA re-nav) refreshes the policy instead of dropping it', () => {
  const t = boot(buildChatGpt);
  assert.strictEqual(typeof t.win.__GENZ_SHIELD_REFRESH__, 'function', 'the refresh hook must exist');
  const observers0 = t.doc._observers.length;
  t.win.__GENZ_SHIELD_REFRESH__(JSON.parse(JSON.stringify(CHATGPT_CFG)));
  assert.strictEqual(t.doc._observers.length, observers0, 'refresh must not spawn a second observer');
  const fresh = t.doc.el('div', { role: 'tablist' }, [
    t.doc.el('button', { role: 'tab', 'aria-selected': 'true' }, ['Chat']),
    t.doc.el('button', { role: 'tab', 'aria-selected': 'false' }, ['Work'])
  ]);
  t.doc.body.appendChild(t.doc.el('div', {}, [fresh]));   // real apps nest it, never body > tablist
  t.doc._mutate([fresh]);
  assert.strictEqual(fresh.hidden, true, 'the policy must still be live after a refresh');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Fail-narrow behaviour
// ─────────────────────────────────────────────────────────────────────────────
test('a page with NO switcher is left completely alone', () => {
  const t = boot((d) => {
    const main = d.el('main', {}, [
      d.el('div', {}, ['Work is important for my project.']),
      d.el('textarea', {}, []),
      d.el('button', {}, ['Send'])
    ]);
    d.body.appendChild(main);
    return { main };
  });
  assert.strictEqual(t.main.hidden, false);
  for (const c of t.main.children) assert.strictEqual(c.hidden, false, 'nothing may be hidden');
});

test('a lone "Work" control with no Chat sibling is NOT removed (no false positive)', () => {
  const t = boot((d) => {
    const wrap = d.el('div', {}, [d.el('button', { role: 'tab', 'aria-selected': 'true' }, ['Work'])]);
    d.body.appendChild(wrap);
    return { wrap };
  });
  assert.strictEqual(t.wrap.children[0].hidden, false,
    'without a permitted Chat sibling the container is not a verified switcher');
});

test('a Chat/Work pair with NO selection marker is not acted on', () => {
  const t = boot((d) => {
    const wrap = d.el('div', {}, [d.el('button', {}, ['Chat']), d.el('button', {}, ['Work'])]);
    d.body.appendChild(wrap);
    return { wrap };
  });
  assert.strictEqual(t.wrap.children[1].hidden, false,
    'requireSelectionMarker must hold — a segmented switcher always marks its active segment');
});

test('a pair inside a huge container is out of bounds (cannot reach the app shell)', () => {
  const t = boot((d) => {
    const kids = [
      d.el('button', { role: 'tab', 'aria-selected': 'true' }, ['Chat']),
      d.el('button', { role: 'tab' }, ['Work'])
    ];
    for (let i = 0; i < 200; i++) kids.push(d.el('span', {}, ['x']));
    const wrap = d.el('div', {}, kids);
    d.body.appendChild(wrap);
    return { wrap };
  });
  assert.strictEqual(t.wrap.hidden, false, 'an oversized subtree is not a switcher');
  assert.strictEqual(t.wrap.children[1].hidden, false);
});

test('a pair sharing a container with the composer is out of scope', () => {
  const t = boot((d) => {
    const wrap = d.el('div', {}, [
      d.el('button', { role: 'tab', 'aria-selected': 'true' }, ['Chat']),
      d.el('button', { role: 'tab' }, ['Work']),
      d.el('textarea', {}, [])
    ]);
    d.body.appendChild(wrap);
    return { wrap };
  });
  assert.strictEqual(t.wrap.hidden, false, 'a composer in scope means we left the switcher');
});

test('a host with NO tabPolicy runs the shield unchanged and ignores Chat/Work entirely', () => {
  const noTab = JSON.parse(JSON.stringify(CHATGPT_CFG));
  delete noTab.tabPolicy;
  const t = boot(buildChatGpt, noTab);
  assert.strictEqual(t.switcher.hidden, false, 'no policy → no removal');
  assert.strictEqual(t.workTab.hidden, false);
  const ev = t.doc._dispatch('click', t.workTab);
  assert.strictEqual(ev.defaultPrevented, false, 'and no interaction guard');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Policy isolation (source-level, portable — mirrors claudeMenuPolicy.test.js)
// ─────────────────────────────────────────────────────────────────────────────
test('ISOLATION: only chatgpt.com carries a tabPolicy', () => {
  const count = (TOOLCFG.match(/tabPolicy:\s*\{/g) || []).length;
  assert.strictEqual(count, 1, 'exactly one tabPolicy must exist');
  const before = TOOLCFG.slice(0, TOOLCFG.indexOf('tabPolicy: {'));
  const hostKeys = before.match(/'[a-z0-9.-]+\.[a-z]{2,}'\s*:/gi) || [];
  const nearest = hostKeys[hostKeys.length - 1] || '';
  assert.match(nearest, /^'chatgpt\.com'\s*:$/,
    `the tabPolicy must sit inside the chatgpt.com override block (nearest host key was ${nearest})`);
});

test('ISOLATION: no other supported tool can receive the policy', () => {
  // Every other tool's override block must be free of tabPolicy.
  for (const host of ['claude.ai', 'ryne.ai']) {
    const i = TOOLCFG.indexOf(`'${host}':`);
    assert.ok(i !== -1, `${host} override must still exist`);
    const block = TOOLCFG.slice(i, i + 4000);
    assert.ok(!/tabPolicy/.test(block), `${host} must not carry a tabPolicy`);
  }
  // Grok, HIX AI, GPT Bypass, WriteHuman and SciSpace have no override block at all, so they
  // can only ever receive SHIELD_DEFAULTS — asserted below.
  for (const host of ['grok.com', 'hix.ai', 'bypassgpt.ai', 'writehuman.ai', 'scispace.com']) {
    assert.ok(!new RegExp(`'${host.replace(/\./g, '\\.')}'\\s*:\\s*\\{[^}]*tabPolicy`).test(TOOLCFG),
      `${host} must not carry a tabPolicy`);
  }
});

test('ISOLATION: getShieldConfig propagates tabPolicy ONLY from a matched host override', () => {
  const fn = TOOLCFG.slice(TOOLCFG.indexOf('export function getShieldConfig'));
  assert.match(fn, /if \(o\.tabPolicy\) cfg\.tabPolicy = o\.tabPolicy;/,
    'the policy must come from the matched override object `o`, never from defaults');
  const defaults = TOOLCFG.slice(TOOLCFG.indexOf('export const SHIELD_DEFAULTS'),
    TOOLCFG.indexOf('export const SHIELD_OVERRIDES'));
  assert.ok(!/tabPolicy/.test(defaults), 'SHIELD_DEFAULTS must never contain a tabPolicy');
});

test('SCOPING: "work" is NOT in the page-wide hideTextSource or href/attr rules', () => {
  const defaults = TOOLCFG.slice(TOOLCFG.indexOf('export const SHIELD_DEFAULTS'),
    TOOLCFG.indexOf('export const SHIELD_OVERRIDES'));
  const m = defaults.match(/hideTextSource:\s*'((?:[^'\\]|\\.)*)'/);
  assert.ok(m, 'hideTextSource must exist');
  assert.ok(!/work/i.test(m[1]),
    '"work" must never enter hideTextSource — that rule runs over every element on the page');
  const hrefs = defaults.match(/hrefSubstrings:\s*\[([\s\S]*?)\]/);
  assert.ok(hrefs && !/work/i.test(hrefs[1]), '"work" must not be an href substring rule');
  const attrs = defaults.match(/attrSubstrings:\s*\[([\s\S]*?)\]/);
  assert.ok(attrs && !/work/i.test(attrs[1]), '"work" must not be an attr substring rule');
  const frags = defaults.match(/blockRouteFragments:\s*\[([\s\S]*?)\]/);
  assert.ok(frags && !/work/i.test(frags[1]),
    '"/work" must not be a global route block — it would apply to every tool');
});

test('SCOPING: the block pattern is anchored to a whole label', () => {
  const m = TOOLCFG.match(/blockLabelSource:\s*'\^work\$'/);
  assert.ok(m, 'blockLabelSource must be the anchored ^work$');
  // The key is deliberately NOT named blockSource: that is the Claude menuPolicy key, and a
  // duplicate name silently hijacked claudeMenuPolicy.test.js's first-match config scraper.
  assert.ok(!/blockSource:\s*'\^work\$'/.test(TOOLCFG),
    'the tab policy must not reuse the menuPolicy key name');
  const re = /^work$/i;
  for (const prose of ['Work is important', 'Workspace', 'Homework', 'work in progress', 'Networking']) {
    assert.ok(!re.test(prose), `"${prose}" must not match`);
  }
  assert.ok(re.test('Work') && re.test('work'), 'the exact label must match');
});

test('SCOPING: identity does not rest on generated CSS class names', () => {
  const i = TOOLCFG.indexOf('tabPolicy: {');
  const block = TOOLCFG.slice(i, TOOLCFG.indexOf('}', TOOLCFG.indexOf('maxRecoveries', i)));
  assert.ok(!/\.[a-z]+-?[0-9a-f]{4,}/i.test(block), 'no hashed/generated class names may be used');
  assert.match(block, /rowSel:/, 'identity comes from roles/structure');
  assert.match(block, /requireSelectionMarker/, 'and from the switcher’s own selection marker');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Architectural guards
// ─────────────────────────────────────────────────────────────────────────────
test('the policy adds no observer, no listener and no timer of its own', () => {
  const src = SHIELD_SRC;
  const tabEngine = src.slice(src.indexOf('// ── TAB POLICY'), src.indexOf('function sweepMenuPolicy'));
  assert.ok(!/new MutationObserver/.test(tabEngine), 'it must reuse the existing observer');
  assert.ok(!/addEventListener/.test(tabEngine), 'it must reuse the existing capture guards');
  assert.ok(!/setInterval|setTimeout/.test(tabEngine), 'no timer may be introduced');
});

test('the tab policy has no network, credential or session surface at all', () => {
  const src = SHIELD_SRC;
  const tabEngine = src.slice(src.indexOf('// ── TAB POLICY'), src.indexOf('function sweepMenuPolicy'));
  for (const bad of ['cookie', 'localStorage', 'sessionStorage', 'chrome.', 'fetch(', 'XMLHttpRequest']) {
    assert.ok(!tabEngine.includes(bad), `the tab policy must not touch ${bad}`);
  }
});

test('the observer cannot be re-triggered by the extension’s own attribute writes', () => {
  const src = SHIELD_SRC;
  const m = src.match(/attributeFilter:\s*\[([^\]]*)\]/);
  assert.ok(m, 'the observer must keep a narrow attributeFilter');
  for (const own of ['data-genz-tab-blocked', 'aria-hidden', 'tabindex', 'style']) {
    assert.ok(!m[1].includes(own), `${own} is written by the shield and must not be observed`);
  }
  assert.ok(m[1].includes('aria-current'), 'aria-current must be observed to catch a mode flip');
});

test('background.js and the lifecycle layer never learn about the tab policy', () => {
  const BG = fs.readFileSync(path.join(EXT, 'js', 'background.js'), 'utf8');
  assert.ok(!/tabPolicy/.test(BG), 'background.js must not reference tabPolicy — it is a DOM rule only');
  assert.ok(!/tabPolicy/.test(fs.readFileSync(path.join(EXT, 'js', 'expired.js'), 'utf8')));
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. ZERO-FLASH bootstrap (the reported "Work shows, then hides" defect)
// ─────────────────────────────────────────────────────────────────────────────
// Root cause: background.js injects shield.js only from chrome.tabs.onUpdated at
// `status === 'complete'` — after first paint, plus service-worker wake-up latency. The fix is
// a DECLARATIVE document_start content script, which has neither delay.
const EARLY_SRC = fs.readFileSync(path.join(EXT, 'js', 'chatgptEarlyShield.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const earlyEntry = MANIFEST.content_scripts.find(
  (c) => (c.js || []).includes('js/chatgptEarlyShield.js'));

test('FLASH FIX: an early content script runs at document_start, before first paint', () => {
  assert.ok(earlyEntry, 'a content_scripts entry must load the ChatGPT bootstrap');
  assert.strictEqual(earlyEntry.run_at, 'document_start',
    'document_idle/document_end would still paint the switcher first — that IS the flash');
  assert.deepStrictEqual(earlyEntry.js, ['js/chatgptEarlyShield.js', 'js/shield.js'],
    'the bootstrap must seed config and then load the real engine, in that order');
});

test('FLASH FIX: the early script is ISOLATED world and chatgpt.com ONLY', () => {
  assert.strictEqual(earlyEntry.world, 'ISOLATED',
    'MAIN world on a third-party origin is what caused the 3.9.15 outage');
  assert.deepStrictEqual(earlyEntry.matches.slice().sort(),
    ['https://*.chatgpt.com/*', 'https://chatgpt.com/*'],
    'no other tool, host or site may load the early script');
  for (const host of ['claude.ai', 'grok.com', 'hix.ai', 'bypassgpt.ai', 'ryne.ai',
                      'writehuman.ai', 'scispace.com', 'genzdigitalstore.com']) {
    assert.ok(!earlyEntry.matches.some((m) => m.includes(host)),
      `${host} must not match the early script`);
  }
});

test('FLASH FIX: the pre-existing bridge.js content script is untouched', () => {
  const bridge = MANIFEST.content_scripts.find((c) => (c.js || []).includes('js/bridge.js'));
  assert.ok(bridge, 'the bridge entry must still exist');
  assert.strictEqual(bridge.run_at, 'document_idle');
  assert.strictEqual(bridge.world, 'ISOLATED');
  assert.deepStrictEqual(bridge.matches, [
    'https://genzdigitalstore.com/*', 'https://app.genzdigitalstore.com/*', 'http://localhost:3000/*'
  ], 'the dashboard bridge must keep its exact original scope');
});

test('FLASH FIX: the bootstrap policy has not drifted from toolConfigs.js', () => {
  const grab = (src) => {
    const i = src.indexOf('tabPolicy: {');
    assert.ok(i !== -1, 'tabPolicy literal not found');
    let d = 0, end = i;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (d === 0) { end = k + 1; break; } }
    }
    return src.slice(src.indexOf('{', i), end)
      .replace(/\/\/[^\n]*/g, '')          // strip comments
      .replace(/\s+/g, '');                 // strip whitespace
  };
  assert.strictEqual(grab(EARLY_SRC), grab(TOOLCFG),
    'the bootstrap copy of tabPolicy must stay identical to the one in toolConfigs.js');
});

test('FLASH FIX: the bootstrap seeds no account/logout rules it could freeze', () => {
  // It must NOT invent href/attr/text/route rules — those arrive with the real config.
  for (const k of ['hrefSubstrings', 'attrSubstrings', 'hideSelectors', 'blockRouteFragments']) {
    assert.ok(new RegExp(k + ':\\s*\\[\\s*\\]').test(EARLY_SRC),
      `${k} must be seeded EMPTY so the real config is authoritative`);
  }
  for (const k of ['hideTextSource', 'keepTextSource']) {
    assert.ok(new RegExp(k + ":\\s*''").test(EARLY_SRC), `${k} must be seeded empty`);
  }
  assert.match(EARLY_SRC, /if \(window\.__GENZ_SHIELD_CFG__\) return;/,
    'the bootstrap must never overwrite a real config already delivered');
});

test('FLASH FIX: the real config fully SUPERSEDES every bootstrap placeholder', () => {
  // Without this, ChatGPT's account/logout shield would be stuck on the empty placeholders.
  const fn = SHIELD_SRC.slice(SHIELD_SRC.indexOf('window.__GENZ_SHIELD_REFRESH__'));
  for (const k of ['hrefSubstrings', 'attrSubstrings', 'hideSelectors', 'blockRouteFragments',
                   'hideTextSource', 'keepTextSource', 'menuPolicy', 'tabPolicy']) {
    assert.ok(fn.includes(k), `refresh must replace cfg.${k}`);
  }
  assert.match(fn, /sweepGen\+\+/,
    'refresh must re-open already-swept nodes, or the bootstrap sweep permanently marks them');
});

test('FLASH FIX: the stylesheet is updatable, not create-once', () => {
  const fn = SHIELD_SRC.slice(SHIELD_SRC.indexOf('function injectStyle'),
    SHIELD_SRC.indexOf('function injectStyle') + 1200);
  assert.ok(!/if \(document\.getElementById\('genz-shield-style'\)\) return;/.test(fn),
    'a create-once stylesheet would freeze the bootstrap’s EMPTY hideSelectors forever');
  assert.match(fn, /s\.textContent !== css/, 'it must update the existing element in place');
});

test('FLASH FIX (behavioural): a switcher rendered AFTER load is hidden pre-paint', () => {
  // Boot with an EMPTY page — exactly the document_start situation — then let "React" insert
  // the switcher. The observer must hide it in the same synchronous callback.
  const t = boot(null);
  const sw = t.doc.el('div', { role: 'tablist' }, [
    t.doc.el('button', { role: 'tab', 'aria-selected': 'true' }, ['Chat']),
    t.doc.el('button', { role: 'tab', 'aria-selected': 'false' }, ['Work'])
  ]);
  t.doc.body.appendChild(t.doc.el('div', {}, [sw]));      // nested, as a real app renders it
  t.doc._mutate([sw]);                       // the observer callback IS the pre-paint microtask
  assert.strictEqual(sw.hidden, true, 'it must already be hidden when the observer returns');
});

test('FLASH FIX (behavioural): bootstrap config then real config keeps BOTH policies live', () => {
  // Simulate the true sequence: document_start bootstrap, then background.js delivers the
  // full config, then ChatGPT re-renders the switcher.
  const bootstrapCfg = {
    enabled: true, hrefSubstrings: [], attrSubstrings: [], hideSelectors: [],
    hideTextSource: '', keepTextSource: '', blockRouteFragments: [],
    tabPolicy: CHATGPT_CFG.tabPolicy
  };
  // The account control is present from the START, so the bootstrap's sweep marks it as
  // already-processed under the EMPTY rules. This is the exact hazard sweepGen exists to fix.
  const t = boot((d) => {
    const built = buildChatGpt(d);
    built.acct = d.el('button', {}, ['Account']);
    d.body.appendChild(built.acct);
    return built;
  }, bootstrapCfg);

  assert.strictEqual(t.switcher.hidden, true, 'Work must be gone from the very first pass');
  assert.strictEqual(t.acct.hidden, false,
    'precondition: the bootstrap has no account rules, so it swept this node without hiding it');

  // Now the real config lands (account rules populated).
  t.win.__GENZ_SHIELD_REFRESH__({
    enabled: true,
    hrefSubstrings: ['logout'], attrSubstrings: ['account'],
    hideSelectors: ['[data-testid="accounts-profile-button"]'],
    hideTextSource: '^(account|settings|log\\s?out)$',
    keepTextSource: '^(chat|new chat|send)$',
    blockRouteFragments: ['/logout'],
    tabPolicy: CHATGPT_CFG.tabPolicy
  });
  t.doc._runTimers();                        // the debounced full re-sweep

  assert.strictEqual(t.acct.hidden, true,
    'the account control must be hidden once the real rules arrive — proves sweepGen re-opened it');
  assert.strictEqual(t.userMsg.hidden, false, 'and the re-sweep must not touch conversation text');
  // And the tab policy must still hold.
  const fresh = t.doc.el('div', { role: 'tablist' }, [
    t.doc.el('button', { role: 'tab', 'aria-selected': 'true' }, ['Chat']),
    t.doc.el('button', { role: 'tab', 'aria-selected': 'false' }, ['Work'])
  ]);
  t.doc.body.appendChild(t.doc.el('div', {}, [fresh]));   // real apps nest it, never body > tablist
  t.doc._mutate([fresh]);
  assert.strictEqual(fresh.hidden, true, 'the tab policy must survive the config swap');
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. BLANK-SCREEN REGRESSION GUARDS
// ─────────────────────────────────────────────────────────────────────────────
// Two defects shipped in 3.9.22 and are fixed here:
//   (a) findSwitch()'s bounds are evaluated when a node is INSERTED. At document_start a
//       structural wrapper can momentarily hold only two links — no composer, tiny subtree —
//       so the climb could select the app shell and display:none the whole application.
//   (b) processOne's sweep generation was bumped on EVERY config refresh, making the entire
//       document re-processable on every shield re-injection. That locked the main thread on
//       large pages (worst on slow connections) and painted a blank page — on ALL tools.

test('BLANK-SCREEN: the app root is never hidden, even if it looks like a switcher', () => {
  const t = boot((d) => {
    // The dangerous early-render shape: a root wrapper holding ONLY Chat and Work.
    const root = d.el('div', { id: '__next' }, [
      d.el('a', { href: '/', 'aria-current': 'page' }, ['Chat']),
      d.el('a', { href: '/work' }, ['Work'])
    ]);
    d.body.appendChild(root);
    return { root };
  });
  assert.strictEqual(t.root.hidden, false, 'the application root must never be display:none');
  assert.strictEqual(t.root.getAttribute('data-genz-tab-blocked'), null);
  assert.strictEqual(t.root.children[1].hidden, true, 'but the Work link itself is still removed');
});

test('BLANK-SCREEN: <main> and landmark containers are never hidden', () => {
  for (const tag of ['main', 'nav', 'header', 'body']) {
    const t = boot((d) => {
      const host = tag === 'body' ? d.body : d.el(tag, {}, []);
      const inner = d.el('div', {}, [
        d.el('button', { role: 'tab', 'aria-selected': 'true' }, ['Chat']),
        d.el('button', { role: 'tab' }, ['Work'])
      ]);
      host.appendChild(inner);
      if (tag !== 'body') d.body.appendChild(d.el('div', {}, [host]));
      return { host, inner };
    });
    assert.strictEqual(t.host.hidden, false, `<${tag}> must never be hidden`);
  }
});

test('BLANK-SCREEN: a container holding the composer is never hidden', () => {
  const t = boot((d) => {
    const wrap = d.el('div', {}, [
      d.el('div', {}, [
        d.el('button', { role: 'tab', 'aria-selected': 'true' }, ['Chat']),
        d.el('button', { role: 'tab' }, ['Work'])
      ]),
      d.el('textarea', {}, [])
    ]);
    d.body.appendChild(d.el('div', {}, [wrap]));
    return { wrap };
  });
  assert.strictEqual(t.wrap.hidden, false, 'hiding the composer’s container blanks the tool');
});

test('BLANK-SCREEN: whole-container removal is deferred while the document is parsing', () => {
  const src = SHIELD_SRC.slice(SHIELD_SRC.indexOf('function vetSwitch'),
    SHIELD_SRC.indexOf('function applyTabPolicy'));
  assert.match(src, /document\.readyState !== 'loading' && !tabOtherControls/,
    'container removal must wait until the DOM has stopped being built');
  assert.match(src, /blockedSelected && document\.readyState !== 'loading'/,
    'the recovery click must not fire into a half-built router');
});

test('BLANK-SCREEN: self-healing restores anything mis-hidden that grew into the app', () => {
  assert.match(SHIELD_SRC, /function verifyHiddenTabNodes/, 'the repair pass must exist');
  assert.match(SHIELD_SRC, /try \{ verifyHiddenTabNodes\(\); \} catch \(e\) \{\}/,
    'and must run from the existing debounced flush — no new timer');
  assert.match(SHIELD_SRC, /data-genz-tab-exempt/, 'a repaired node must never be re-hidden');
});

test('PERF: the sweep generation only advances when the RULES actually change', () => {
  // This is the all-tools white-screen fix. Re-injection with the same host config must NOT
  // re-open the whole document for re-processing.
  const fn = SHIELD_SRC.slice(SHIELD_SRC.indexOf('window.__GENZ_SHIELD_REFRESH__'));
  assert.match(fn, /var sig = rulesSignature\(\);/, 'the rule set must be fingerprinted');
  assert.match(fn, /if \(sig !== lastRulesSig\) \{[\s\S]{0,120}sweepGen\+\+;/,
    'sweepGen must be bumped ONLY on a real rules change');
  assert.ok(!/^\s*sweepGen\+\+;\s*$/m.test(fn.replace(/if \(sig !== lastRulesSig\)[\s\S]*/, '')),
    'no unconditional bump may remain');
});

test('PERF: the expensive captcha check is out of the per-node hot path', () => {
  // Strip comments first — the function documents WHY the call is absent, and matching that
  // prose instead of a real call is exactly how this assertion would rot into a false failure.
  const fn = SHIELD_SRC.slice(SHIELD_SRC.indexOf('function processOne'),
    SHIELD_SRC.indexOf('function sweep('))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/isCaptchaNode\s*\(/.test(fn),
    'isCaptchaNode does matches+closest+querySelector over 18 selectors — not once per node');
  // Safety is preserved: hide() still refuses captcha nodes.
  const hideFn = SHIELD_SRC.slice(SHIELD_SRC.indexOf('function hide(n)'),
    SHIELD_SRC.indexOf('function hide(n)') + 400);
  assert.match(hideFn, /isCaptchaNode\(n\)/, 'hide() must still refuse to hide a captcha');
});

test('PERF (behavioural): re-injecting the SAME config does not re-sweep the document', () => {
  const t = boot(buildChatGpt);
  // Mark every element so we can detect a full re-process.
  const all = t.doc.body.querySelectorAll('div');
  const before = all.map((e) => e.__genzShield);
  t.win.__GENZ_SHIELD_REFRESH__(JSON.parse(JSON.stringify(CHATGPT_CFG)));
  t.doc._runTimers();
  const after = t.doc.body.querySelectorAll('div').map((e) => e.__genzShield);
  assert.deepStrictEqual(after, before,
    'identical rules must leave every node’s generation untouched — this is the white-screen fix');
});

test('PERF (behavioural): a REAL rules change still re-sweeps exactly once', () => {
  const bootstrapCfg = {
    enabled: true, hrefSubstrings: [], attrSubstrings: [], hideSelectors: [],
    hideTextSource: '', keepTextSource: '', blockRouteFragments: [],
    tabPolicy: CHATGPT_CFG.tabPolicy
  };
  const t = boot((d) => {
    const built = buildChatGpt(d);
    built.acct = d.el('button', {}, ['Account']);
    d.body.appendChild(d.el('div', {}, [built.acct]));
    return built;
  }, bootstrapCfg);
  assert.strictEqual(t.acct.hidden, false, 'bootstrap has no account rules');
  t.win.__GENZ_SHIELD_REFRESH__(JSON.parse(JSON.stringify(CHATGPT_CFG)));
  t.doc._runTimers();
  assert.strictEqual(t.acct.hidden, true, 'the real rules must still take effect');
});

test('the managed-session gate is the EXISTING one — no new host or permission', () => {
  const BG = fs.readFileSync(path.join(EXT, 'js', 'background.js'), 'utf8');
  assert.match(BG, /if \(tool \|\| isShieldHost\(hostname\)\) \{/,
    'the existing shield injection gate must be reused unchanged');
  const hosts = TOOLCFG.match(/export const SHIELD_HOSTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(hosts && hosts[1].includes("'chatgpt.com'"), 'chatgpt.com must already be a shield host');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.permissions.slice().sort(),
    ['alarms', 'cookies', 'management', 'notifications', 'scripting', 'storage', 'tabs'],
    'no permission change may accompany this feature');
});
