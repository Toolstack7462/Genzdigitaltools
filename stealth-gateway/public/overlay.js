/* Gen Z StealthWriter overlay — injected into the proxied StealthWriter app.
 *
 * 1) Bottom-right floating glass widget: "Gen Z Digital Store / StealthWriter",
 *    30-minute countdown, support button, clean friendly messages. No top bar,
 *    no usage counters, never covers the editor/buttons.
 * 2) Visual-only hiding of StealthWriter's account / plan / pricing / FAQ / support /
 *    Discord / affiliate / subscription UI and its original usage counters, so the
 *    sidebar shows only Dashboard / Humanizer / AI Detector. SPA-safe (MutationObserver
 *    + route hooks). Never hides the working area (textarea, Humanize, Check for AI).
 *
 * This is purely cosmetic — it does NOT touch StealthWriter's backend, limits,
 * subscription, payment or login, and never logs cookies/secrets.
 */
(function () {
  'use strict';
  var CFG = window.__GENZ_GATEWAY__ || {};
  var API = (CFG.api || '').replace(/\/$/, '');
  var SUPPORT_URL = CFG.support || 'https://app.genzdigitalstore.com/client/dashboard';
  if (!API) return;

  var HUMANIZE_RE = CFG.humanizePattern ? new RegExp(CFG.humanizePattern, 'i') : /humaniz|rephrase|rewrite|paraphras/i;
  var DETECT_RE   = CFG.detectPattern   ? new RegExp(CFG.detectPattern, 'i')   : /detect|detector|ai-?score|ai-?check/i;

  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }
  var LEASE = getCookie('sw_lease');

  var MSG = {
    lease_expired:   'Your access session expired. Please open StealthWriter again from your dashboard.',
    lease_revoked:   'Your access session ended. Please open StealthWriter again from your dashboard.',
    lease_invalid:   'Your access session expired. Please open StealthWriter again from your dashboard.',
    lease_missing:   'Your access session expired. Please open StealthWriter again from your dashboard.',
    client_disabled: 'Your StealthWriter access is not active right now. Please contact support.',
    plan_expired:    'Your StealthWriter plan has ended. Please contact support to renew.',
    no_account:      'StealthWriter is temporarily unavailable. Please contact support.',
    unavailable:     'Access could not be verified. Please refresh or contact support.',
    limit_humanizer: "You've reached today's Humanizer limit. It resets at 5:00 AM PKT.",
    limit_detector:  "You've reached today's AI Detector limit. It resets at 5:00 AM PKT.",
  };
  function friendly(code) {
    if (MSG[code]) return MSG[code];
    if (code === 'account_blocked' || code === 'account_no_session' || code === 'client_not_found') return MSG.no_account;
    return MSG.unavailable;
  }

  var state = { secondsRemaining: 0, terminal: false, collapsed: false };
  var el = {};
  function fmtTime(s) { if (s < 0) s = 0; var m = Math.floor(s / 60), x = s % 60; return m + ':' + (x < 10 ? '0' : '') + x; }

  // ── Floating widget (brand + countdown + support) ──────────────────────────
  function buildWidget() {
    var w = document.createElement('div');
    w.id = 'genz-sw-widget';
    w.innerHTML =
      '<div class="genz-sw-head">' +
        '<span class="genz-sw-brand">Gen Z Digital Store</span>' +
        '<button class="genz-sw-min" title="Minimize" aria-label="Minimize">–</button>' +
      '</div>' +
      '<div class="genz-sw-body">' +
        '<div class="genz-sw-sub">StealthWriter</div>' +
        '<div class="genz-sw-row"><span>Session</span><b id="genz-sw-time">--:--</b></div>' +
        '<div class="genz-sw-msg" id="genz-sw-msg"></div>' +
        '<a class="genz-sw-support" href="' + SUPPORT_URL + '" target="_blank" rel="noopener">Contact support</a>' +
      '</div>';
    document.documentElement.appendChild(w);
    el.widget = w; el.time = w.querySelector('#genz-sw-time'); el.msg = w.querySelector('#genz-sw-msg');
    el.min = w.querySelector('.genz-sw-min'); el.head = w.querySelector('.genz-sw-head');
    el.min.addEventListener('click', toggleCollapse);
    el.head.addEventListener('click', function (e) { if (state.collapsed && e.target !== el.min) toggleCollapse(); });
  }
  function toggleCollapse() { state.collapsed = !state.collapsed; el.widget.classList.toggle('genz-sw-collapsed', state.collapsed); el.min.textContent = state.collapsed ? '+' : '–'; }
  function render() { if (!el.widget) return; el.time.textContent = fmtTime(state.secondsRemaining); el.widget.classList.toggle('genz-sw-warn', state.secondsRemaining <= 60 && !state.terminal); el.widget.classList.toggle('genz-sw-error', !!state.terminal); }
  function showMessage(text, terminal) { if (!el.msg) return; el.msg.textContent = text; el.msg.style.display = text ? 'block' : 'none'; if (terminal) { state.terminal = true; if (state.collapsed) toggleCollapse(); } render(); }
  function clearMessage() { if (el.msg) { el.msg.textContent = ''; el.msg.style.display = 'none'; } }
  function toast(text) { var t = document.createElement('div'); t.className = 'genz-sw-toast'; t.textContent = text; document.documentElement.appendChild(t); setTimeout(function () { t.classList.add('genz-sw-toast-out'); }, 2800); setTimeout(function () { t.remove(); }, 3400); }

  function apiCall(endpoint, payload) {
    return fetch(API + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + (LEASE || '') }, body: JSON.stringify(payload || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); });
  }

  function validate() {
    if (state.terminal) return Promise.resolve();
    return apiCall('/validate', {}).then(function (r) {
      if (r.status === 200 && r.body && r.body.valid) { state.secondsRemaining = r.body.secondsRemaining || 0; clearMessage(); render(); }
      else showMessage(friendly(r.body && r.body.code), true);
    }).catch(function () {});
  }
  function tick() { if (state.terminal) return; state.secondsRemaining -= 1; if (state.secondsRemaining <= 0) validate(); render(); }

  // ── Usage metering (background; not displayed) ─────────────────────────────────
  function actionFor(url) { if (HUMANIZE_RE.test(url)) return 'humanizer'; if (DETECT_RE.test(url)) return 'detector'; return null; }
  function consume(action) {
    return apiCall('/consume', { action: action }).then(function (r) {
      if (r.body && typeof r.body.secondsRemaining === 'number') { state.secondsRemaining = r.body.secondsRemaining; render(); }
      var allowed = !!(r.body && r.body.allowed);
      if (!allowed) { var code = r.body && r.body.code; if (code === 'limit_reached') toast(action === 'humanizer' ? MSG.limit_humanizer : MSG.limit_detector); else showMessage(friendly(code), code !== 'invalid_action'); }
      return allowed;
    }).catch(function () { return false; });
  }
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      if (url.indexOf(API) === 0) return origFetch(input, init);
      var action = actionFor(url);
      if (!action) return origFetch(input, init);
      return consume(action).then(function (ok) { if (!ok) return Promise.reject(new Error('GENZ_LIMIT_BLOCKED')); return origFetch(input, init); });
    };
  }
  var X = window.XMLHttpRequest;
  if (X) {
    var oOpen = X.prototype.open, oSend = X.prototype.send;
    X.prototype.open = function (method, url) { this.__genzAction = (url && url.indexOf(API) !== 0) ? actionFor(url) : null; return oOpen.apply(this, arguments); };
    X.prototype.send = function () { var self = this, args = arguments; if (!self.__genzAction) return oSend.apply(self, args); consume(self.__genzAction).then(function (ok) { if (ok) oSend.apply(self, args); else { try { self.abort(); } catch (e) {} } }); };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VISUAL HIDING of account / plan / pricing / FAQ / support / Discord / affiliate /
  // subscription UI and StealthWriter's own usage counters. SPA-safe. Cosmetic only.
  // ════════════════════════════════════════════════════════════════════════════
  // Hide these labels (exact-ish short text on links/buttons/nav items).
  var HIDE_RE = /^(account|my account|account settings|profile|plans?\s*&?\s*pricing|pricing|faq|faqs|help|support|contact us|discord|community|affiliate|affiliate program|refer|refer a friend|invite friends|subscription|manage subscription|billing|manage plan|upgrade|upgrade plan|get more|starter plan|free plan|basic plan|pro plan|premium( plan)?|enterprise)$/i;
  // Hide StealthWriter's own usage/reset counters.
  var USAGE_RE = /(\d+\s*\/\s*\d+\s*(humaniz|scan|word|credit)|humanizations?\s+left|scans?\s+left|words?\s+left|credits?\s+left|resets?\s+(in|at|on|every|daily|tomorrow)|words?\s+remaining|usage\s+resets)/i;
  // NEVER hide the working area / allowed nav.
  var KEEP_RE = /^(dashboard|humanizer|ai detector|ai-detector|humanize|check for ai|detect ai|paraphrase|input|output|copy|paste|new|history|home)$/i;

  function ownText(n) { var s = ''; for (var i = 0; i < n.childNodes.length; i++) { var c = n.childNodes[i]; if (c.nodeType === 3) s += c.nodeValue; } return s.trim(); }
  function hasEditor(n) { return !!(n.querySelector && n.querySelector('textarea,[contenteditable="true"],input')); }
  function hide(n) { if (n && n.style) { n.style.setProperty('display', 'none', 'important'); n.setAttribute('data-genz-hidden', '1'); } }
  function nearestControl(n) { var d = 0, c = n; while (c && d < 4) { var tag = (c.tagName || '').toLowerCase(); if (tag === 'a' || tag === 'button' || tag === 'li' || (c.getAttribute && c.getAttribute('role') === 'button')) return c; c = c.parentElement; d++; } return n; }

  function sweep(root) {
    var nodes;
    try { nodes = (root && root.querySelectorAll ? root : document).querySelectorAll('a,button,[role="button"],li,span,div,p,h1,h2,h3,h4'); } catch (e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.__genz || n.id === 'genz-sw-widget' || (n.closest && n.closest('#genz-sw-widget'))) continue;
      n.__genz = true;
      var t = ownText(n);
      if (!t || t.length > 60) continue;
      if (KEEP_RE.test(t)) continue;            // protect Dashboard/Humanizer/AI Detector/buttons
      if (hasEditor(n)) continue;               // never hide a container with the editor
      if (HIDE_RE.test(t)) { hide(nearestControl(n)); continue; }   // account/plan/pricing/etc → hide the whole control
      if (USAGE_RE.test(t)) { hide(n); }         // StealthWriter usage/reset counters → hide the label
    }
  }

  // href / aria based hiding (robust against obfuscated class names) via injected CSS.
  function injectHideStyle() {
    var css =
      'a[href*="pricing"],a[href*="billing"],a[href*="account"],a[href*="affiliate"],a[href*="discord"],' +
      'a[href*="/faq"],a[href*="support"],a[href*="subscription"],a[href*="upgrade"],a[href*="refer"],' +
      'a[href*="plans"],[data-genz-hidden="1"]{display:none !important;}';
    var s = document.createElement('style'); s.id = 'genz-sw-hide'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  function runHiding() { try { sweep(document); } catch (e) {} }

  function start() {
    if (!LEASE) { buildWidget(); showMessage(MSG.lease_missing, true); return; }
    if (CFG.capture) { buildCaptureUI(); return; }
    buildWidget();
    injectHideStyle();
    runHiding();
    // SPA-safe: re-run on DOM mutations, on route changes, and on a light interval.
    var mo = new MutationObserver(function () { runHiding(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    var _ps = history.pushState; history.pushState = function () { var r = _ps.apply(this, arguments); setTimeout(runHiding, 60); return r; };
    window.addEventListener('popstate', function () { setTimeout(runHiding, 60); });
    setInterval(runHiding, 1500);
    validate();
    setInterval(tick, 1000);
    setInterval(validate, 30000);
  }

  // ── Capture mode (admin) ─────────────────────────────────────────────────────
  function buildCaptureUI() {
    var w = document.createElement('div'); w.id = 'genz-sw-widget';
    w.innerHTML = '<div class="genz-sw-head"><span class="genz-sw-brand">Gen Z · Capture</span></div>' +
      '<div class="genz-sw-body"><div class="genz-sw-msg" style="display:block">Log in to your StealthWriter account, then save the session.</div>' +
      '<button class="genz-sw-support" id="genz-sw-save" style="border:0;cursor:pointer">💾 Save session to vault</button></div>';
    document.documentElement.appendChild(w);
    var btn = w.querySelector('#genz-sw-save');
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Saving…';
      fetch('/__genz/save-session', { method: 'POST', credentials: 'same-origin' }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) { if (j && j.ok) { btn.textContent = '✓ Saved'; toast('Session saved. You can close this tab.'); } else { btn.disabled = false; btn.textContent = '💾 Save session to vault'; toast('Could not save — make sure you are logged in first.'); } })
        .catch(function () { btn.disabled = false; btn.textContent = '💾 Save session to vault'; toast('Save failed.'); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
