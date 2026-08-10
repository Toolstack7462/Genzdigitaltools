/**
 * Gen Z account/logout SHIELD for extension-opened tools.
 *
 * Injected by background.js (chrome.scripting.executeScript) into the REAL tool tab
 * that opens in the member's own browser with a Gen Z-managed session. STANDARDIZED across
 * every supported extension-based tool (HIX AI, GPT Bypass, Ryne, WriteHuman, …) via the
 * shared SHIELD config. Two jobs:
 *   1. Hide shared-account chrome (account/profile menu, logout, billing, pricing, upgrade,
 *      subscription, settings links) so a member can't read or change the shared account.
 *   2. Block access to restricted pages — both when a restricted link is CLICKED and when a
 *      restricted URL is OPENED directly (direct entry, refresh, new tab, SPA route change,
 *      account switch, login/logout). Instead of access, a professional managed-account popup
 *      is shown ("Go to Dashboard" / "Close").
 *
 * It is the EXTENSION-side equivalent of the proxy gateways' overlay.js; the rules are
 * NOT hardcoded here — they arrive as config (window.__GENZ_SHIELD_CFG__) from the
 * single source of truth in js/config/toolConfigs.js (SHIELD_DEFAULTS), so nothing is
 * duplicated within the extension.
 *
 * SAFETY (must never regress):
 *  - Never hides inputs, textareas, [contenteditable], forms, selects, iframes, or
 *    anything inside the editor / chat / upload / result working area.
 *  - Never touches captcha / challenge widgets (login & anti-abuse stay intact).
 *  - Purely cosmetic + click guarding. Touches no cookies, tokens, storage or secrets,
 *    and never bypasses login, payment, captcha, rate limits or platform restrictions.
 */
(function () {
  'use strict';
  var CFG = window.__GENZ_SHIELD_CFG__;
  if (!CFG || CFG.enabled === false) return;

  // Idempotent: a second injection (SPA reuse / re-nav) just refreshes config + re-runs.
  if (window.__GENZ_SHIELD_ACTIVE__) {
    try { window.__GENZ_SHIELD_REFRESH__ && window.__GENZ_SHIELD_REFRESH__(CFG); } catch (e) {}
    return;
  }
  window.__GENZ_SHIELD_ACTIVE__ = true;

  var hrefSubs = CFG.hrefSubstrings || [];
  var attrSubs = CFG.attrSubstrings || [];
  var hideSelectors = CFG.hideSelectors || [];
  var blockFrags = CFG.blockRouteFragments || [];
  var HIDE_TEXT_RE = safeRe(CFG.hideTextSource, 'i');
  var KEEP_TEXT_RE = safeRe(CFG.keepTextSource, 'i');
  var EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

  // Restricted-URL popup copy + dashboard origin (validated; safe fallback).
  var MODAL_ID = 'genz-shield-modal';
  var RESTRICT_TITLE = CFG.restrictTitle || 'Access restricted';
  var RESTRICT_MSG = CFG.restrictMessage ||
    'This account is managed by Gen Z Digital Store. Account settings and subscription management are handled by the administrator.';
  var APP_ORIGIN = (function () {
    var a = String(CFG.appOrigin || '').replace(/\/+$/, '');
    return /^https:\/\/[\w.-]+$/i.test(a) ? a : 'https://app.genzdigitalstore.com';
  })();

  function safeRe(src, flags) { try { return src ? new RegExp(src, flags) : null; } catch (e) { return null; } }

  // ── Captcha / challenge protection — NEVER hide these ───────────────────────
  var CAPTCHA_SEL = [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="turnstile"]',
    'iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="/recaptcha/"]',
    '.g-recaptcha', '#g-recaptcha', '.grecaptcha-badge', '.h-captcha', '.cf-turnstile',
    '[class*="recaptcha" i]', '[id*="recaptcha" i]', '[class*="captcha" i]', '[id*="captcha" i]',
    '[class*="turnstile" i]', '[class*="hcaptcha" i]', '[class*="challenge" i]', '[data-sitekey]'
  ].join(',');
  function isCaptchaNode(n) {
    if (!n || n.nodeType !== 1) return false;
    try {
      if (n.matches && n.matches(CAPTCHA_SEL)) return true;
      if (n.closest && n.closest(CAPTCHA_SEL)) return true;
      if (n.querySelector && n.querySelector(CAPTCHA_SEL)) return true;
    } catch (e) {}
    return false;
  }

  // Working-area guard: anything that IS or CONTAINS an editable/input/iframe is the
  // tool's working surface — never hide it.
  function hasWorkArea(n) {
    try { return !!(n.querySelector && n.querySelector('textarea,[contenteditable="true"],input,select,iframe')); }
    catch (e) { return false; }
  }
  function isWorkArea(n) {
    var t = (n.tagName || '').toLowerCase();
    if (t === 'textarea' || t === 'input' || t === 'select' || t === 'iframe' || t === 'form') return true;
    if (n.getAttribute && n.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function ownText(n) {
    var s = '';
    for (var i = 0; i < n.childNodes.length; i++) { var c = n.childNodes[i]; if (c.nodeType === 3) s += c.nodeValue; }
    return s.trim();
  }
  function nearestControl(n) {
    var d = 0, c = n;
    while (c && d < 4) {
      var tag = (c.tagName || '').toLowerCase();
      if (tag === 'a' || tag === 'button' || tag === 'li' || (c.getAttribute && c.getAttribute('role') === 'button')) return c;
      c = c.parentElement; d++;
    }
    return n;
  }
  // Our own injected UI (the restricted popup) must never be swept/hidden.
  function isOwnUi(n) {
    try { return !!(n && n.nodeType === 1 && (n.id === MODAL_ID || (n.closest && n.closest('#' + MODAL_ID)))); }
    catch (e) { return false; }
  }
  function hide(n) {
    if (!n || n.nodeType !== 1) return;
    if (isWorkArea(n) || hasWorkArea(n) || isCaptchaNode(n)) return;     // never hide working area / captcha
    if (isOwnUi(n)) return;
    try { n.style.setProperty('display', 'none', 'important'); n.setAttribute('data-genz-shield-hidden', '1'); } catch (e) {}
  }

  function attrMatches(n) {
    var a = ((n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('data-testid') || '')) || '').toLowerCase();
    if (!a) return false;
    for (var i = 0; i < attrSubs.length; i++) { if (a.indexOf(attrSubs[i]) !== -1) return true; }
    return false;
  }

  // ── Static hide style (href substrings + per-tool exact selectors) ──────────
  function injectStyle() {
    if (document.getElementById('genz-shield-style')) return;
    var parts = [];
    for (var i = 0; i < hrefSubs.length; i++) parts.push('a[href*="' + hrefSubs[i] + '" i]');
    for (var j = 0; j < hideSelectors.length; j++) { if (hideSelectors[j]) parts.push(hideSelectors[j]); }
    parts.push('[data-genz-shield-hidden="1"]');
    // Menu policy rows: the attribute survives a React re-render that rewrites the inline
    // style attribute, so the row stays hidden without us having to win a styling race.
    parts.push('[data-genz-menu-blocked="1"]');
    var css = parts.join(',') + '{display:none !important;}';
    var s = document.createElement('style'); s.id = 'genz-shield-style'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Sweep: hide account/logout/billing controls by attr/text/email ──────────
  // Each element is evaluated AT MOST ONCE (marked with __genzShield). PERF: the observer
  // below sweeps only the subtrees that were ADDED, so cost scales with NEW content instead of
  // re-scanning the whole DOM on every mutation (critical on streaming SPAs like ChatGPT/Grok).
  // processOne holds the identical per-node rules as before.
  var SWEEP_SEL = 'a,button,[role="button"],li,span,div,p,h1,h2,h3,h4';
  function processOne(n) {
    if (!n || n.nodeType !== 1 || n.__genzShield) return;
    if (isOwnUi(n) || isCaptchaNode(n) || isWorkArea(n)) { n.__genzShield = true; return; }
    n.__genzShield = true;
    var tag = (n.tagName || '').toLowerCase();
    var isControl = tag === 'a' || tag === 'button' || (n.getAttribute && n.getAttribute('role') === 'button');
    if (isControl && attrMatches(n)) { hide(n); return; }
    var t = ownText(n);
    if (!t || t.length > 60) return;
    if (KEEP_TEXT_RE && KEEP_TEXT_RE.test(t)) return;
    if (hasWorkArea(n)) return;
    if (EMAIL_RE.test(t)) { hide(nearestControl(n)); return; }
    if (HIDE_TEXT_RE && HIDE_TEXT_RE.test(t)) { hide(nearestControl(n)); }
  }
  function sweep(root) {
    var base = (root && root.nodeType === 1) ? root : (document.body || document.documentElement);
    if (!base) return;
    try {
      if (base.matches && base.matches(SWEEP_SEL)) processOne(base); // the subtree root itself
      var nodes = base.querySelectorAll(SWEEP_SEL);
      for (var i = 0; i < nodes.length; i++) processOne(nodes[i]);
    } catch (e) {}
    sweepMenuPolicy(base);
  }

  // ── Menu policy: remove specific rows from an OPEN picker (Claude model/effort) ─────────
  // Deliberately NOT part of processOne / hideTextSource: those run over every a/button/li/
  // span/div/p/h1-h4 on the page, so a word like "High" or "Max" would be blanked inside a
  // conversation, an artifact or a code block. Everything here is gated on the row living
  // inside an open menu/listbox popover, so page content is never touched. Config-driven and
  // host-scoped, so a tool without a menuPolicy behaves exactly as before.
  var MENU = (CFG.menuPolicy && CFG.menuPolicy.containers && CFG.menuPolicy.items) ? CFG.menuPolicy : null;
  var MENU_BLOCK_RE = MENU ? safeRe(MENU.blockSource, 'i') : null;
  var MENU_KEEP_RE = MENU ? safeRe(MENU.keepSource, 'i') : null;

  // A row's label is its FIRST text-bearing child chunk. Claude's model rows render the name
  // and a description as sibling children ("Max" + "Maximum reasoning"), so whole-textContent
  // matching would produce "MaxMaximum reasoning" and match nothing.
  //
  // Deliberately NOT innerText: innerText is layout-dependent and returns '' for a row we have
  // ALREADY hidden, which silently collapsed the label back to concatenated textContent and let
  // a click through on a blocked row. Walking childNodes is visibility-independent, so the same
  // verdict holds whether the row is displayed or not — which is what the click guard needs.
  function menuLabel(n) {
    try {
      for (var i = 0; i < n.childNodes.length; i++) {
        var t = (n.childNodes[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (t) return t.slice(0, 40);
      }
      return (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    } catch (e) { return ''; }
  }
  function menuBlocked(n) {
    if (!MENU_BLOCK_RE) return false;
    var label = menuLabel(n);
    if (!label) return false;
    if (MENU_KEEP_RE && MENU_KEEP_RE.test(label)) return false;   // keep wins
    return MENU_BLOCK_RE.test(label);
  }
  // ── Effort picker, identified by CONTENT rather than by ARIA role ──────────────────────
  // The role-based pass below only fires when a row is BOTH inside a [role=menu|listbox] AND is
  // itself a [role=menuitem|option]. Claude's effort control satisfies neither, so it was never
  // touched. Instead of guessing at more roles, find the picker by what it contains: a cluster of
  // SIBLING rows each labelled exactly an effort word.
  //
  // The two-sibling + one-permitted requirement is the whole safety argument. Prose cannot
  // produce sibling elements labelled exactly "Low" and "High"; a picker always does. A lone
  // "Max" in a conversation has no effort-word sibling and is therefore never considered.
  var EFFORT_ROW_SEL = (MENU && MENU.effortRowSel) || null;
  var EFFORT_WORD_RE = MENU ? safeRe(MENU.effortWordSource, 'i') : null;
  var EFFORT_ALLOW_RE = MENU ? safeRe(MENU.effortAllowSource, 'i') : null;

  function effortLabel(n) {
    var l = menuLabel(n);
    return (l && l.length <= 12 && EFFORT_WORD_RE && EFFORT_WORD_RE.test(l)) ? l : null;
  }
  function sweepEffortGroups(base) {
    if (!EFFORT_ROW_SEL || !EFFORT_WORD_RE || !EFFORT_ALLOW_RE) return;
    var rows;
    try { rows = base.querySelectorAll(EFFORT_ROW_SEL); } catch (e) { return; }
    // Bucket effort-labelled rows by their parent — siblings of a picker share one.
    var buckets = [], keys = [];
    for (var i = 0; i < rows.length; i++) {
      var lab = effortLabel(rows[i]);
      if (!lab) continue;
      var p = rows[i].parentNode;
      if (!p) continue;
      var k = keys.indexOf(p);
      if (k === -1) { keys.push(p); buckets.push([]); k = keys.length - 1; }
      buckets[k].push({ el: rows[i], label: lab });
    }
    for (var b = 0; b < buckets.length; b++) {
      var grp = buckets[b];
      if (grp.length < 2) continue;                                    // not a picker
      var hasAllowed = false;
      for (var g = 0; g < grp.length; g++) if (EFFORT_ALLOW_RE.test(grp[g].label)) hasAllowed = true;
      if (!hasAllowed) continue;                                       // not an effort picker
      var blockedSelected = null, fallback = null;
      for (var h = 0; h < grp.length; h++) {
        if (EFFORT_ALLOW_RE.test(grp[h].label)) {
          // Prefer Medium as the fallback; fall back to whatever permitted row exists.
          if (!fallback || /^medium$/i.test(grp[h].label)) fallback = grp[h].el;
          continue;                                                    // Low / Medium stay
        }
        if (isSelectedRow(grp[h].el)) blockedSelected = grp[h].el;
        try {
          grp[h].el.setAttribute('data-genz-menu-blocked', '1');
          grp[h].el.style.setProperty('display', 'none', 'important');
        } catch (e) {}
      }
      // A conversation already pinned to High/Max must not stay there. Choose the permitted
      // level through the APP'S OWN handler (a real click on the Medium row) rather than by
      // writing to storage we do not understand — the app then updates the composer, persists
      // its own preference and stays internally consistent. Guarded so it happens at most once
      // per rendered group, which stops any click/re-render loop.
      if (blockedSelected && fallback && !keys[b].__genzEffortFixed) {
        keys[b].__genzEffortFixed = true;
        try { fallback.click(); } catch (e) {}
      }
    }
  }
  // Is this row the currently-chosen level? Covers the ARIA states and the common
  // data-state/class conventions, since we cannot rely on Claude's specific markup.
  function isSelectedRow(el) {
    try {
      if (el.getAttribute('aria-checked') === 'true') return true;
      if (el.getAttribute('aria-selected') === 'true') return true;
      var ds = el.getAttribute('data-state') || '';
      if (/^(checked|active|selected|on)$/i.test(ds)) return true;
      if (el.querySelector && el.querySelector('[data-state="checked"],[aria-checked="true"]')) return true;
      return /(^|\s)(is-)?(selected|active|checked)(\s|$)/i.test(el.className || '');
    } catch (e) { return false; }
  }
  // True when the row sits in a confirmed effort picker and is not a permitted level. Used by the
  // click guard so a blocked level cannot be chosen even if a re-render outruns the hide.
  function effortBlocked(n) {
    if (!EFFORT_WORD_RE || !EFFORT_ALLOW_RE) return false;
    var lab = effortLabel(n);
    if (!lab || EFFORT_ALLOW_RE.test(lab)) return false;
    var p = n.parentNode; if (!p) return false;
    var sibs = p.children || [], seen = 0, allowed = false;
    for (var i = 0; i < sibs.length; i++) {
      var l = effortLabel(sibs[i]);
      if (!l) continue;
      seen++;
      if (EFFORT_ALLOW_RE.test(l)) allowed = true;
    }
    return seen >= 2 && allowed;
  }

  function sweepMenuPolicy(root) {
    if (!MENU) return;
    try {
      var base = (root && root.nodeType === 1) ? root : (document.body || document.documentElement);
      if (!base) return;
      sweepEffortGroups(base);
      var seen = [];
      if (base.matches && base.matches(MENU.containers)) seen.push(base);
      // A mutation often lands INSIDE an already-open popover, so walk up as well as down.
      var up = base.closest && base.closest(MENU.containers);
      if (up) seen.push(up);
      var found = base.querySelectorAll(MENU.containers);
      for (var i = 0; i < found.length; i++) seen.push(found[i]);
      for (var c = 0; c < seen.length; c++) {
        var items = seen[c].querySelectorAll(MENU.items);
        // No "already processed" marker: a picker holds a handful of rows and React reuses
        // nodes with NEW labels across opens, so a cached verdict would go stale and let a
        // blocked row reappear on the second open. Re-deciding is cheap at this scale.
        for (var j = 0; j < items.length; j++) {
          if (menuBlocked(items[j])) {
            try {
              items[j].setAttribute('data-genz-menu-blocked', '1');
              items[j].style.setProperty('display', 'none', 'important');
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  // ── Professional restricted-access popup ────────────────────────────────────
  // Replaces the old toast. Shown whenever the member tries to reach a restricted page —
  // by clicking a restricted link OR by landing on a restricted URL directly (direct entry,
  // refresh, new tab, SPA route change, account switch / login-logout re-render).
  //   • hardBlock=true  → the CURRENT page itself is restricted: an opaque backdrop covers
  //                       the page so the restricted content can't be read/used. "Close"
  //                       sends the member to the tool home ('/') rather than revealing it.
  //   • hardBlock=false → a restricted link click on an otherwise-fine page: "Close" just
  //                       dismisses the popup and the member stays where they were.
  // Buttons: "Go to Dashboard" (member dashboard) and "Close". Purely UI — touches no
  // cookies/tokens/session and never bypasses anything.
  var modalEl = null;
  function buildModal() {
    if (modalEl && document.documentElement.contains(modalEl)) return modalEl;
    var wrap = document.createElement('div');
    wrap.id = MODAL_ID;
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;';

    var backdrop = document.createElement('div');
    backdrop.setAttribute('data-genz-backdrop', '1');
    backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(4,16,31,.78);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);';
    wrap.appendChild(backdrop);

    var card = document.createElement('div');
    card.style.cssText = 'position:relative;width:100%;max-width:440px;background:rgba(10,24,48,.97);' +
      'border:1px solid rgba(6,182,212,.32);border-radius:20px;padding:34px 30px;text-align:center;' +
      'box-shadow:0 24px 60px rgba(2,8,23,.6);color:#eaf1fb;';

    var badge = document.createElement('div');
    badge.style.cssText = 'width:54px;height:54px;margin:0 auto 16px;border-radius:14px;display:flex;' +
      'align-items:center;justify-content:center;background:linear-gradient(135deg,#2563EB,#06B6D4);' +
      'box-shadow:0 8px 24px rgba(6,182,212,.35);font-size:26px;line-height:1;';
    badge.textContent = '🔒';
    card.appendChild(badge);

    var h = document.createElement('h1');
    h.style.cssText = 'font-size:21px;font-weight:700;margin:0 0 10px;color:#f3f8ff;letter-spacing:-.01em;';
    h.textContent = RESTRICT_TITLE;
    card.appendChild(h);

    var p = document.createElement('p');
    p.style.cssText = 'color:rgba(234,241,251,.74);font-size:14.5px;line-height:1.6;margin:0 0 24px;';
    p.textContent = RESTRICT_MSG;
    card.appendChild(p);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;';

    var dash = document.createElement('a');
    dash.id = 'genz-shield-dash';
    dash.href = APP_ORIGIN + '/client/dashboard';
    dash.target = '_self';
    dash.textContent = 'Go to Dashboard';
    dash.style.cssText = 'text-decoration:none;background:linear-gradient(135deg,#2563EB 0%,#06B6D4 100%);' +
      'color:#fff;font-weight:700;font-size:14px;padding:12px 22px;border-radius:11px;cursor:pointer;' +
      'box-shadow:0 8px 24px rgba(37,99,235,.28);';
    row.appendChild(dash);

    var close = document.createElement('button');
    close.id = 'genz-shield-close';
    close.type = 'button';
    close.textContent = 'Close';
    close.style.cssText = 'background:transparent;color:#cfe0f5;font-weight:600;font-size:14px;' +
      'padding:12px 22px;border:1px solid rgba(207,224,245,.28);border-radius:11px;cursor:pointer;';
    close.addEventListener('click', function () {
      if (wrap.__hardBlock) { try { location.replace('/'); } catch (e) { location.href = '/'; } }
      else hideModal();
    });
    row.appendChild(close);

    card.appendChild(row);
    wrap.appendChild(card);
    (document.body || document.documentElement).appendChild(wrap);
    modalEl = wrap;
    return wrap;
  }
  function hideModal() {
    if (!modalEl) return;
    try { modalEl.style.display = 'none'; } catch (e) {}
    try { document.documentElement.style.overflow = modalEl.__prevOverflow || ''; } catch (e) {}
  }
  function showRestrictedPopup(hardBlock) {
    var m = buildModal();
    m.__hardBlock = !!hardBlock;
    m.style.display = 'flex';
    if (hardBlock) {
      // Lock scrolling so the restricted page underneath can't be read/used.
      try { m.__prevOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden'; } catch (e) {}
    }
  }

  function pathIsBlocked(pathname) {
    var p = String(pathname || '').toLowerCase();
    for (var i = 0; i < blockFrags.length; i++) { if (p.indexOf(blockFrags[i]) !== -1) return true; }
    return false;
  }

  // Restricted page loaded directly (URL entry, refresh, new tab) or reached via SPA route
  // change / account switch → hard-block with the popup. Re-evaluated on every route change.
  function maybeBlockCurrentRoute() {
    try {
      if (pathIsBlocked(location.pathname)) showRestrictedPopup(true);
      else if (modalEl && modalEl.__hardBlock) hideModal();   // navigated back to an allowed route
    } catch (e) {}
  }

  // ── Click guard: stop navigations to logout/account/billing routes ──────────
  // Capture-phase so it runs before the app's own handlers. Only blocks anchors/role
  // links that resolve to a blocked route; never interferes with the working area.
  function onClickCapture(ev) {
    try {
      // Menu policy: refuse the selection outright, not just visually. Capture phase runs
      // before the app's own handler, so even if a re-render briefly showed the row (or a
      // keyboard/synthetic activation reached it), the blocked choice cannot be made.
      if (MENU && ev.target && ev.target.closest) {
        var mi = ev.target.closest(MENU.items);
        if (mi && mi.closest(MENU.containers) && menuBlocked(mi)) {
          ev.preventDefault(); ev.stopPropagation();
          if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
          return;
        }
        // Same refusal for an effort row identified by content rather than by role.
        var er = EFFORT_ROW_SEL ? ev.target.closest(EFFORT_ROW_SEL) : null;
        if (er && effortBlocked(er)) {
          ev.preventDefault(); ev.stopPropagation();
          if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
          return;
        }
      }
      var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      if (isOwnUi(a) || isWorkArea(a) || isCaptchaNode(a)) return;
      var url;
      try { url = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
      if (url.host && url.host !== location.host) return;     // external link — leave alone
      if (pathIsBlocked(url.pathname)) {
        ev.preventDefault(); ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        showRestrictedPopup(false);
      }
    } catch (e) {}
  }

  // ── Scheduling: incremental by default, full only when needed ────────────────
  // PERF: only the nodes a mutation ADDED are swept (cost ∝ new content) instead of the whole
  // DOM on every change. A full re-sweep is reserved for first run, config refresh and SPA route
  // changes (when account chrome can re-render). injectStyle() is cheap + idempotent.
  var pending = [];
  var flushTimer = null;
  var fullPending = false;
  function flush() {
    flushTimer = null;
    try { injectStyle(); } catch (e) {}
    if (fullPending) { fullPending = false; pending.length = 0; try { sweep(document); } catch (e) {} return; }
    if (!pending.length) return;
    var batch = pending; pending = [];
    for (var i = 0; i < batch.length; i++) { try { sweep(batch[i]); } catch (e) {} }
  }
  function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, 150); }
  function scheduleFull() { fullPending = true; schedule(); }
  function onMutations(muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) { var n = added[j]; if (n && n.nodeType === 1) pending.push(n); }
    }
    if (pending.length > 2000) { fullPending = true; pending.length = 0; } // huge burst → one full sweep
    if (pending.length || fullPending) schedule();
  }

  window.__GENZ_SHIELD_REFRESH__ = function (cfg) {
    if (!cfg) return;
    if (Array.isArray(cfg.blockRouteFragments)) blockFrags = cfg.blockRouteFragments;
    if (Array.isArray(cfg.hideSelectors)) hideSelectors = cfg.hideSelectors;
    // Re-injection on an SPA re-nav must not silently drop the menu policy.
    if (cfg.menuPolicy && cfg.menuPolicy.containers && cfg.menuPolicy.items) {
      MENU = cfg.menuPolicy;
      MENU_BLOCK_RE = safeRe(MENU.blockSource, 'i');
      MENU_KEEP_RE = safeRe(MENU.keepSource, 'i');
    }
    scheduleFull();
    maybeBlockCurrentRoute();
  };

  // Re-sweep account chrome AND re-check the restricted-route block on any SPA navigation.
  function onRouteChange() { scheduleFull(); maybeBlockCurrentRoute(); }

  function start() {
    try { injectStyle(); } catch (e) {}
    try { sweep(document); } catch (e) {}
    maybeBlockCurrentRoute();   // direct entry / refresh / new tab onto a restricted URL
    var mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('click', onClickCapture, true);
    // SPA route changes → full re-sweep + restricted-route re-check (account chrome can
    // re-render and the path can change to/from a restricted page without a full load).
    var _ps = history.pushState; history.pushState = function () { var r = _ps.apply(this, arguments); onRouteChange(); return r; };
    var _rs = history.replaceState; history.replaceState = function () { var r = _rs.apply(this, arguments); onRouteChange(); return r; };
    window.addEventListener('popstate', onRouteChange);
    // Low-frequency safety net (marked nodes are skipped, so this is cheap).
    setInterval(scheduleFull, 4000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
