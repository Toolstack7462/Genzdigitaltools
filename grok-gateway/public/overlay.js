/* Gen Z Proxy-Tool overlay — injected into the proxied HIX AI / BypassGPT app.
 *
 * 1) Small bottom-right floating widget: "Gen Z Digital Store" title, the tool name
 *    subtitle, session time left, and a Contact-support button. Collapsible. No top
 *    bar; never covers the editor/buttons.
 * 2) NO usage metering and NO daily limits — the widget only shows the 30-minute
 *    session countdown and re-validates the lease with the Gen Z backend.
 * 3) Account identity is replaced with the Gen Z Digital Store brand and account /
 *    plan / billing / pricing / subscription / API-keys / logout UI is hidden. This
 *    runs as EXTRA cleanup only — the gateway already blocks/sanitizes these at the
 *    server. Never hides the working area (textarea, Humanize, result area).
 *
 * Purely cosmetic — does NOT touch the tool's backend, limits, login or payment,
 * and never logs cookies/secrets.
 */
(function () {
  'use strict';
  var CFG = window.__GENZ_GATEWAY__ || {};
  var API = (CFG.api || '').replace(/\/$/, '');
  var TOOL_NAME = CFG.toolName || 'AI Tool';
  var SUPPORT_URL = CFG.support || 'https://app.genzdigitalstore.com/client/dashboard';
  if (!API) return;

  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }
  var LEASE = getCookie('pg_lease');

  var MSG = {
    lease_expired:   'Your access session expired. Please open the tool again from your dashboard.',
    lease_revoked:   'Your access session ended. Please open the tool again from your dashboard.',
    lease_invalid:   'Your access session expired. Please open the tool again from your dashboard.',
    lease_missing:   'Your access session expired. Please open the tool again from your dashboard.',
    client_disabled: 'Your access is not active right now. Please contact support.',
    plan_expired:    'Your access has ended. Please contact support to renew.',
    no_account:      TOOL_NAME + ' is temporarily unavailable. Please contact support.',
    unavailable:     'Access could not be verified. Please refresh or contact support.',
  };
  function friendly(code) {
    if (MSG[code]) return MSG[code];
    if (code === 'account_blocked' || code === 'account_no_session' || code === 'client_not_found') return MSG.no_account;
    return MSG.unavailable;
  }

  var state = { secondsRemaining: 0, terminal: false, collapsed: false, friendlyShown: false };
  var el = {};
  function fmtTime(s) { if (s < 0) s = 0; var m = Math.floor(s / 60), x = s % 60; return m + ':' + (x < 10 ? '0' : '') + x; }

  // ── Floating widget — brand + tool name + session + support ─────────────────
  function buildWidget() {
    var w = document.createElement('div');
    w.id = 'genz-sw-widget';
    w.innerHTML =
      '<div class="genz-sw-head">' +
        '<div class="genz-sw-brandwrap">' +
          '<span class="genz-sw-title">Gen Z Digital Store</span>' +
          '<span class="genz-sw-sub"></span>' +
        '</div>' +
        '<button class="genz-sw-min" title="Minimize" aria-label="Minimize">–</button>' +
      '</div>' +
      '<div class="genz-sw-body">' +
        '<div class="genz-sw-row genz-sw-cd"><span>Session</span><b id="genz-sw-time">--:--</b></div>' +
        '<div class="genz-sw-msg" id="genz-sw-msg"></div>' +
        '<a class="genz-sw-support" href="' + SUPPORT_URL + '" target="_blank" rel="noopener" title="Contact support">Contact support</a>' +
      '</div>';
    document.documentElement.appendChild(w);
    el.widget = w; el.time = w.querySelector('#genz-sw-time'); el.msg = w.querySelector('#genz-sw-msg');
    el.min = w.querySelector('.genz-sw-min'); el.head = w.querySelector('.genz-sw-head');
    w.querySelector('.genz-sw-sub').textContent = TOOL_NAME; // textContent → no HTML injection
    el.min.addEventListener('click', toggleCollapse);
    el.head.addEventListener('click', function (e) { if (state.collapsed && e.target !== el.min) toggleCollapse(); });
  }
  function toggleCollapse() { state.collapsed = !state.collapsed; el.widget.classList.toggle('genz-sw-collapsed', state.collapsed); el.min.textContent = state.collapsed ? '+' : '–'; }
  function render() { if (!el.widget) return; el.time.textContent = fmtTime(state.secondsRemaining); el.widget.classList.toggle('genz-sw-warn', state.secondsRemaining <= 60 && !state.terminal); el.widget.classList.toggle('genz-sw-error', !!state.terminal); }
  function showMessage(text, terminal) { if (!el.msg) return; el.msg.textContent = text; el.msg.style.display = text ? 'block' : 'none'; if (terminal) { state.terminal = true; if (state.collapsed) toggleCollapse(); } render(); }
  function clearMessage() { if (el.msg) { el.msg.textContent = ''; el.msg.style.display = 'none'; } }
  function showFriendlyError() { if (state.friendlyShown) return; state.friendlyShown = true; showMessage(MSG.unavailable, false); }
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

  // ════════════════════════════════════════════════════════════════════════════
  // EXTRA UI cleanup (backup to the server-side shield): hide account / plan /
  // pricing / billing / subscription / API-keys / logout and brand the identity.
  // ════════════════════════════════════════════════════════════════════════════
  var HIDE_RE = /^(account|my account|account settings|account details|profile|my profile|settings|preferences|log\s?out|sign\s?out|logout|plans?\s*&?\s*pricing|pricing|faq|faqs|help|help center|support|contact us|discord|community|affiliate|affiliate program|refer|refer a friend|invite friends?|earn|rewards|subscription|manage subscription|billing|manage plan|upgrade|upgrade plan|api keys?|api key|developer|get more|starter plan|free plan|basic plan|pro plan|premium( plan)?|enterprise)$/i;
  var USAGE_RE = /(\d+\s*\/\s*\d+\s*(humaniz|scan|word|credit)|words?\s+(left|remaining)|credits?\s+left|resets?\s+(in|at|on|every|daily|tomorrow)|usage\s+resets)/i;
  var EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  var FORBIDDEN_RE = /^(forbidden|403\s*forbidden|403|access denied|unauthorized|401)\.?$/i;
  var KEEP_RE = /^(dashboard|humanizer|ai detector|ai-detector|humanize|check for ai|detect ai|bypass|paraphrase|input|output|copy|paste|new|history|home)$/i;
  var BRAND = 'Gen Z Digital Store';
  var AVATAR_SEL = '[class*="avatar" i],[class*="initial" i],[class*="userpic" i],[data-avatar],img,svg';
  var brandControls = [];

  // ── Captcha / challenge PROTECTION ──────────────────────────────────────────
  // The tool shows a real captcha (Google reCAPTCHA / hCaptcha / Turnstile /
  // Cloudflare challenge) before sensitive actions. The user must solve it manually.
  // The cleanup sweep below must NEVER hide, brandify, or remove these widgets or
  // their containers/iframes — doing so would make the captcha disappear.
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
      if (n.closest && n.closest(CAPTCHA_SEL)) return true;   // inside a captcha container
      if (n.querySelector && n.querySelector(CAPTCHA_SEL)) return true; // wraps a captcha
    } catch (e) {}
    return false;
  }
  // Friendly, persistent hint shown while a captcha is on screen (separate from the
  // widget's status line so the lease countdown never clears it).
  function captchaHint(show) {
    var id = 'genz-captcha-hint', e = document.getElementById(id);
    if (show) {
      if (!e) {
        e = document.createElement('div'); e.id = id;
        e.textContent = 'Please complete the verification to continue.';
        e.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483646;' +
          'background:#111a2e;color:#e2e8f0;border:1px solid rgba(6,182,212,.45);padding:10px 16px;border-radius:10px;' +
          'font:600 13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:none;';
        document.documentElement.appendChild(e);
      }
    } else if (e) { e.remove(); }
  }
  // Only prompt when a REAL, VISIBLE challenge popup is on screen (the reCAPTCHA/hCaptcha
  // image-grid "bframe"). Invisible reCAPTCHA (a hidden badge) has nothing to solve, so we
  // must NOT tell the user to "complete the verification" for it.
  function visibleChallenge() {
    try {
      var fr = document.querySelectorAll('iframe[src*="bframe"],iframe[title*="recaptcha challenge" i],iframe[src*="hcaptcha"][title*="challenge" i],iframe[src*="challenges.cloudflare.com"]');
      for (var i = 0; i < fr.length; i++) {
        var f = fr[i], r = f.getBoundingClientRect();
        if (r.width > 60 && r.height > 60 && f.offsetParent !== null) return true;
      }
    } catch (e) {}
    return false;
  }
  function checkCaptcha() { try { captchaHint(visibleChallenge()); } catch (e) {} }

  function ownText(n) { var s = ''; for (var i = 0; i < n.childNodes.length; i++) { var c = n.childNodes[i]; if (c.nodeType === 3) s += c.nodeValue; } return s.trim(); }
  function hasEditor(n) { return !!(n.querySelector && n.querySelector('textarea,[contenteditable="true"],input')); }
  function hide(n) { if (isCaptchaNode(n)) return; if (n && n.style && !(n.getAttribute && n.getAttribute('data-genz-brand') === '1')) { n.style.setProperty('display', 'none', 'important'); n.setAttribute('data-genz-hidden', '1'); } }
  function nearestControl(n) { var d = 0, c = n; while (c && d < 4) { var tag = (c.tagName || '').toLowerCase(); if (tag === 'a' || tag === 'button' || tag === 'li' || (c.getAttribute && c.getAttribute('role') === 'button')) return c; c = c.parentElement; d++; } return n; }
  function brandifyControl(ctrl) { if (!ctrl || hasEditor(ctrl)) return; if (brandControls.indexOf(ctrl) === -1) brandControls.push(ctrl); enforceBranding(); }
  // ChatGPT shows its real account at the BOTTOM-LEFT of the sidebar (avatar + name,
  // opening a menu that can switch / log into / log out of the account). The client must
  // never reach it, so for ChatGPT we HIDE the account control entirely and show our own
  // "Gen Z Digital Store" card on the left instead of branding the control in place.
  var CHATGPT = (CFG.tool === 'chatgpt');
  function brandOrHide(n) { if (CHATGPT) hide(n); else brandifyControl(n); }
  function isIdentityControl(n) {
    if (!n || hasEditor(n)) return false;
    if (n.querySelector && n.querySelector('[class*="avatar" i],[class*="initial" i],[class*="userpic" i],[data-avatar]')) return true;
    var a = ((n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('data-testid') || '')) || '').toLowerCase();
    if (/(^|[\s_-])(user[\s_-]?menu|usermenu|avatar)([\s_-]|$)/.test(a)) return true;
    if (n.getAttribute && n.getAttribute('aria-haspopup') && /(^|[\s_-])(account|profile|my[\s_-]?account)([\s_-]|$)/.test(a)) return true;
    // ChatGPT: a bottom-left button/link carrying an avatar image is the account switcher.
    if (CHATGPT && n.querySelector && n.querySelector('img')) {
      try { var r = n.getBoundingClientRect(); if (r.width && r.left < 360 && r.top > window.innerHeight * 0.55) return true; } catch (e) {}
    }
    return false;
  }
  // Hide ChatGPT's bottom-left account control (testid/aria + bottom-left-avatar heuristic).
  function hideChatgptAccount() {
    if (!CHATGPT) return;
    try {
      var marked = document.querySelectorAll('[data-testid*="account" i],[data-testid*="profile" i],[data-testid="accounts-profile-button"]');
      for (var i = 0; i < marked.length; i++) { var c = marked[i].closest('button,[role="button"],a') || marked[i]; if (!c.closest('#genz-sw-widget,#genz-acct-card')) hide(c); }
      var btns = document.querySelectorAll('button,[role="button"],a');
      for (var j = 0; j < btns.length; j++) {
        var b = btns[j];
        if (b.closest('#genz-sw-widget,#genz-acct-card')) continue;
        if (!(b.querySelector && b.querySelector('img'))) continue;
        var r = b.getBoundingClientRect();
        if (r.width && r.left < 360 && r.top > window.innerHeight * 0.6) hide(b);
      }
    } catch (e) {}
  }
  // The replacement: a clean, fixed "Gen Z Digital Store" card pinned bottom-left.
  function buildChatgptAccountCard() {
    if (!CHATGPT || document.getElementById('genz-acct-card')) return;
    var c = document.createElement('div'); c.id = 'genz-acct-card';
    c.innerHTML = '<span class="genz-acct-ava">G</span>' +
      '<span class="genz-acct-txt"><b>Gen Z Digital Store</b><i>Member access</i></span>';
    document.documentElement.appendChild(c);
  }
  function enforceBranding() {
    for (var i = brandControls.length - 1; i >= 0; i--) {
      var ctrl = brandControls[i];
      if (!ctrl || !document.contains(ctrl)) { brandControls.splice(i, 1); continue; }
      ctrl.setAttribute('data-genz-brand', '1');
      if (ctrl.getAttribute('data-genz-hidden') === '1') { ctrl.style.removeProperty('display'); ctrl.removeAttribute('data-genz-hidden'); }
      var leaves = ctrl.querySelectorAll('span,p,small,b,strong,div,a,' + AVATAR_SEL);
      for (var j = 0; j < leaves.length; j++) {
        var lf = leaves[j];
        if (lf.className === 'genz-brand-tag' || (lf.querySelector && lf.querySelector('.genz-brand-tag'))) continue;
        if (hasEditor(lf)) continue;
        var tagL = (lf.tagName || '').toLowerCase();
        var cls = (lf.getAttribute && lf.getAttribute('class')) || '';
        if (tagL === 'img' || tagL === 'svg' || /avatar|initial|userpic/i.test(cls)) { lf.style.setProperty('display', 'none', 'important'); continue; }
        var tx = ownText(lf);
        if (tx && !KEEP_RE.test(tx) && tx.length <= 80) lf.style.setProperty('display', 'none', 'important');
      }
      for (var k = 0; k < ctrl.childNodes.length; k++) {
        var cn = ctrl.childNodes[k];
        if (cn.nodeType === 3 && cn.nodeValue && cn.nodeValue.trim()) cn.nodeValue = '';
      }
      if (!ctrl.querySelector('.genz-brand-tag')) {
        var tag = document.createElement('span');
        tag.className = 'genz-brand-tag'; tag.textContent = BRAND;
        tag.style.cssText = 'font-weight:600;color:inherit;white-space:nowrap;';
        ctrl.appendChild(tag);
      }
    }
  }
  function sweep(root) {
    var nodes;
    try { nodes = (root && root.querySelectorAll ? root : document).querySelectorAll('a,button,[role="button"],li,span,div,p,h1,h2,h3,h4'); } catch (e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.__genz || n.id === 'genz-sw-widget' || (n.closest && n.closest('#genz-sw-widget'))) continue;
      if (isCaptchaNode(n)) continue;   // NEVER hide/brand a captcha/challenge widget (re-checked each sweep)
      n.__genz = true;
      var ctag = (n.tagName || '').toLowerCase();
      if ((ctag === 'button' || ctag === 'a' || (n.getAttribute && n.getAttribute('role') === 'button')) && isIdentityControl(n)) { brandOrHide(n); continue; }
      var t = ownText(n);
      if (!t || t.length > 60) continue;
      if (KEEP_RE.test(t)) continue;
      if (hasEditor(n)) continue;
      if (FORBIDDEN_RE.test(t)) { showFriendlyError(); hide(nearestControl(n)); continue; }
      if (EMAIL_RE.test(t)) { brandOrHide(nearestControl(n)); continue; }
      if (HIDE_RE.test(t)) { hide(nearestControl(n)); continue; }
      if (USAGE_RE.test(t)) { hide(n); }
    }
  }
  function injectHideStyle() {
    var hrefs = ['pricing', 'billing', 'account', 'affiliate', 'discord', '/faq', 'support', 'subscription',
      'upgrade', 'refer', 'plans', '/settings', '/profile', '/me', 'api-key', 'apikey',
      'logout', 'log-out', 'sign-out', 'signout'];
    var css = hrefs.map(function (h) { return 'a[href*="' + h + '"]:not([data-genz-brand])'; }).join(',') +
      ',[data-genz-hidden="1"]{display:none !important;}';
    var s = document.createElement('style'); s.id = 'genz-sw-hide'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  function runHiding() { try { sweep(document); enforceBranding(); checkCaptcha(); hideChatgptAccount(); } catch (e) {} }

  function start() {
    if (!LEASE) { buildWidget(); showMessage(MSG.lease_missing, true); return; }
    if (CFG.capture) { buildCaptureUI(); return; }
    buildWidget();
    buildChatgptAccountCard();
    injectHideStyle();
    runHiding();
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
      '<div class="genz-sw-body"><div class="genz-sw-msg" style="display:block">Log in to your ' + '</div>' +
      '<button class="genz-sw-support" id="genz-sw-save" style="border:0;cursor:pointer">💾 Save session to vault</button></div>';
    document.documentElement.appendChild(w);
    w.querySelector('.genz-sw-msg').textContent = 'Log in to your ' + TOOL_NAME + ' account, then save the session.';
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
