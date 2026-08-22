/**
 * Shared minimal DOM harness for shield.js behavioural tests.
 *
 * shield.js is an IIFE that runs against a live document. To prove BEHAVIOUR (rather than assert
 * on source text) it is executed for real inside a node:vm realm against the DOM implemented
 * here — no jsdom, no new dependency, no second test framework.
 *
 * Selector support is intentionally narrow: comma lists of tag, [attr], [attr="v"] and
 * [attr*="v"] (with an optional case-insensitivity flag), plus tag[attr]. Anything else —
 * class selectors, :has() — is UNPARSEABLE BY DESIGN and matches nothing, so a harness gap
 * can only ever make a test fail, never make one falsely pass.
 *
 * Timers are queued, not fired: call doc._runTimers() to stand in for the event loop. Mutation
 * observers are pumped with doc._mutate(added, attrTargets), which is what the browser does
 * synchronously, pre-paint.
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const SHIELD_SRC = fs.readFileSync(path.join(EXT, 'js', 'shield.js'), 'utf8');

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
// Build a document, seed the shield config, then execute the REAL shield.js against it.
function bootShield(buildFn, cfg) {
  const { doc, win, ctx } = makeDom();
  const built = buildFn ? buildFn(doc) : {};
  win.__GENZ_SHIELD_CFG__ = JSON.parse(JSON.stringify(cfg));
  vm.runInContext(SHIELD_SRC, ctx);
  return Object.assign({ doc, win, ctx }, built);
}

module.exports = { makeDom, bootShield, parseSel, SHIELD_SRC, EXT };
