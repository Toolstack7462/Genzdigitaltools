/**
 * Gen Z account/logout SHIELD for extension-opened tools.
 *
 * Injected by background.js (chrome.scripting.executeScript) into the REAL tool tab
 * that opens in the member's own browser with a Gen Z-managed session. Its only job is
 * to hide shared-account chrome (account/profile menu, logout, billing, upgrade,
 * subscription, settings links) and to intercept clicks to logout/account/billing
 * routes — so a member can't read the shared account details or accidentally log the
 * account out for everyone.
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
  function hide(n) {
    if (!n || n.nodeType !== 1) return;
    if (isWorkArea(n) || hasWorkArea(n) || isCaptchaNode(n)) return;     // never hide working area / captcha
    if (n.id === 'genz-shield-toast') return;
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
    var css = parts.join(',') + '{display:none !important;}';
    var s = document.createElement('style'); s.id = 'genz-shield-style'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Sweep: hide account/logout/billing controls by attr/text/email ──────────
  function sweep(root) {
    var nodes;
    try { nodes = (root && root.querySelectorAll ? root : document).querySelectorAll('a,button,[role="button"],li,span,div,p,h1,h2,h3,h4'); }
    catch (e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.__genzShield) continue;
      if (isCaptchaNode(n) || isWorkArea(n)) { n.__genzShield = true; continue; }
      n.__genzShield = true;
      var tag = (n.tagName || '').toLowerCase();
      var isControl = tag === 'a' || tag === 'button' || (n.getAttribute && n.getAttribute('role') === 'button');
      if (isControl && attrMatches(n)) { hide(n); continue; }
      var t = ownText(n);
      if (!t || t.length > 60) continue;
      if (KEEP_TEXT_RE && KEEP_TEXT_RE.test(t)) continue;
      if (hasWorkArea(n)) continue;
      if (EMAIL_RE.test(t)) { hide(nearestControl(n)); continue; }
      if (HIDE_TEXT_RE && HIDE_TEXT_RE.test(t)) { hide(nearestControl(n)); }
    }
  }

  // ── Friendly toast (shown when a blocked route click is intercepted) ────────
  function toast(msg) {
    var id = 'genz-shield-toast', e = document.getElementById(id);
    if (!e) {
      e = document.createElement('div'); e.id = id;
      e.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;' +
        'background:#111a2e;color:#e2e8f0;border:1px solid rgba(6,182,212,.45);padding:11px 18px;border-radius:10px;' +
        'font:600 13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.4);' +
        'max-width:340px;text-align:center;pointer-events:none;opacity:0;transition:opacity .2s ease;';
      document.documentElement.appendChild(e);
    }
    e.textContent = msg;
    requestAnimationFrame(function () { e.style.opacity = '1'; });
    clearTimeout(e.__t); e.__t = setTimeout(function () { e.style.opacity = '0'; }, 2600);
  }

  function pathIsBlocked(pathname) {
    var p = String(pathname || '').toLowerCase();
    for (var i = 0; i < blockFrags.length; i++) { if (p.indexOf(blockFrags[i]) !== -1) return true; }
    return false;
  }

  // ── Click guard: stop navigations to logout/account/billing routes ──────────
  // Capture-phase so it runs before the app's own handlers. Only blocks anchors/role
  // links that resolve to a blocked route; never interferes with the working area.
  function onClickCapture(ev) {
    try {
      var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      if (isWorkArea(a) || isCaptchaNode(a)) return;
      var url;
      try { url = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
      if (url.host && url.host !== location.host) return;     // external link — leave alone
      if (pathIsBlocked(url.pathname)) {
        ev.preventDefault(); ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        toast('Account & billing are managed by Gen Z Digital Store.');
      }
    } catch (e) {}
  }

  var sweepTimer = null;
  function runHiding() {
    try { injectStyle(); sweep(document); } catch (e) {}
  }
  function scheduleSweep() { clearTimeout(sweepTimer); sweepTimer = setTimeout(runHiding, 80); }

  window.__GENZ_SHIELD_REFRESH__ = function (cfg) {
    if (!cfg) return;
    if (Array.isArray(cfg.blockRouteFragments)) blockFrags = cfg.blockRouteFragments;
    if (Array.isArray(cfg.hideSelectors)) hideSelectors = cfg.hideSelectors;
    scheduleSweep();
  };

  function start() {
    runHiding();
    var mo = new MutationObserver(scheduleSweep);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('click', onClickCapture, true);
    // SPA route changes → re-sweep (hidden chrome can re-render on navigation).
    var _ps = history.pushState; history.pushState = function () { var r = _ps.apply(this, arguments); scheduleSweep(); return r; };
    var _rs = history.replaceState; history.replaceState = function () { var r = _rs.apply(this, arguments); scheduleSweep(); return r; };
    window.addEventListener('popstate', scheduleSweep);
    setInterval(runHiding, 2000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
