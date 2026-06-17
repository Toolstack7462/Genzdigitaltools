/* Gen Z StealthWriter usage overlay — injected into the proxied StealthWriter app.
 *
 * UI: a single bottom-right floating glass widget (no top bar). Shows a 30-min
 * countdown, remaining humanizer / AI-detector usage, a support button, and clean,
 * user-friendly messages. It NEVER shows technical terms (Forbidden, 403, cookie,
 * lease, token, proxy, upstream, backend). The backend remains the source of truth;
 * this widget only reflects state and meters humanize/detect actions.
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

  // Friendly, non-technical messages keyed by backend code (no Forbidden/403/etc.).
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
  // Map any backend code to a friendly message (default = generic, never technical).
  function friendly(code) {
    if (MSG[code]) return MSG[code];
    if (code === 'account_blocked' || code === 'account_no_session' || code === 'client_not_found') return MSG.no_account;
    return MSG.unavailable;
  }

  var state = { secondsRemaining: 0, remaining: { humanizer: null, detector: null }, plan: '', terminal: false, collapsed: false };

  // ── Floating widget ───────────────────────────────────────────────────────
  var el = {};
  function fmt(n) { return n === null || n === undefined ? '∞' : String(n); }
  function fmtTime(s) { if (s < 0) s = 0; var m = Math.floor(s / 60), x = s % 60; return m + ':' + (x < 10 ? '0' : '') + x; }

  function buildWidget() {
    var w = document.createElement('div');
    w.id = 'genz-sw-widget';
    w.innerHTML =
      '<div class="genz-sw-head">' +
        '<span class="genz-sw-brand">Gen Z · StealthWriter</span>' +
        '<button class="genz-sw-min" title="Minimize" aria-label="Minimize">–</button>' +
      '</div>' +
      '<div class="genz-sw-body">' +
        '<div class="genz-sw-row"><span>Session</span><b id="genz-sw-time">--:--</b></div>' +
        '<div class="genz-sw-row"><span>Humanizer</span><b id="genz-sw-hum">–</b></div>' +
        '<div class="genz-sw-row"><span>AI Detector</span><b id="genz-sw-det">–</b></div>' +
        '<div class="genz-sw-msg" id="genz-sw-msg"></div>' +
        '<a class="genz-sw-support" id="genz-sw-support" href="' + SUPPORT_URL + '" target="_blank" rel="noopener">Contact support</a>' +
      '</div>';
    document.documentElement.appendChild(w);
    el.widget = w;
    el.time = w.querySelector('#genz-sw-time');
    el.hum = w.querySelector('#genz-sw-hum');
    el.det = w.querySelector('#genz-sw-det');
    el.msg = w.querySelector('#genz-sw-msg');
    el.min = w.querySelector('.genz-sw-min');
    el.head = w.querySelector('.genz-sw-head');
    el.min.addEventListener('click', toggleCollapse);
    el.head.addEventListener('click', function (e) { if (state.collapsed && e.target !== el.min) toggleCollapse(); });
  }
  function toggleCollapse() {
    state.collapsed = !state.collapsed;
    el.widget.classList.toggle('genz-sw-collapsed', state.collapsed);
    el.min.textContent = state.collapsed ? '+' : '–';
  }
  function render() {
    if (!el.widget) return;
    el.time.textContent = fmtTime(state.secondsRemaining);
    el.hum.textContent = fmt(state.remaining.humanizer);
    el.det.textContent = fmt(state.remaining.detector);
    el.widget.classList.toggle('genz-sw-warn', state.secondsRemaining <= 60 && !state.terminal);
    el.widget.classList.toggle('genz-sw-error', !!state.terminal);
  }
  // Show a clean message in the widget. terminal=true stops the countdown/usage.
  function showMessage(text, terminal) {
    if (!el.msg) return;
    el.msg.textContent = text;
    el.msg.style.display = text ? 'block' : 'none';
    if (terminal) { state.terminal = true; el.widget.classList.add('genz-sw-error'); if (state.collapsed) toggleCollapse(); }
    render();
  }
  function clearMessage() { if (el.msg) { el.msg.textContent = ''; el.msg.style.display = 'none'; } }
  function toast(text) {
    var t = document.createElement('div');
    t.className = 'genz-sw-toast';
    t.textContent = text;
    document.documentElement.appendChild(t);
    setTimeout(function () { t.classList.add('genz-sw-toast-out'); }, 2800);
    setTimeout(function () { t.remove(); }, 3400);
  }

  function apiCall(endpoint, payload) {
    return fetch(API + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + (LEASE || '') },
      body: JSON.stringify(payload || {}),
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); });
  }

  // ── Validation loop ───────────────────────────────────────────────────────
  function validate() {
    if (state.terminal) return Promise.resolve();
    return apiCall('/validate', {}).then(function (r) {
      if (r.status === 200 && r.body && r.body.valid) {
        state.secondsRemaining = r.body.secondsRemaining || 0;
        state.remaining = (r.body.plan && r.body.plan.remaining) || state.remaining;
        state.plan = (r.body.plan && r.body.plan.planName) || state.plan;
        clearMessage();
        render();
      } else {
        var code = r.body && r.body.code;
        showMessage(friendly(code), true); // terminal: session no longer valid
      }
    }).catch(function () { /* transient — keep last known state, no scary message */ });
  }
  function tick() {
    if (state.terminal) return;
    state.secondsRemaining -= 1;
    if (state.secondsRemaining <= 0) validate();
    render();
  }

  // ── Usage metering ───────────────────────────────────────────────────────────
  function actionFor(url) { if (HUMANIZE_RE.test(url)) return 'humanizer'; if (DETECT_RE.test(url)) return 'detector'; return null; }
  function consume(action) {
    return apiCall('/consume', { action: action }).then(function (r) {
      if (r.body) {
        if (r.body.remaining) state.remaining = r.body.remaining;
        if (typeof r.body.secondsRemaining === 'number') state.secondsRemaining = r.body.secondsRemaining;
        render();
      }
      var allowed = !!(r.body && r.body.allowed);
      if (!allowed) {
        var code = r.body && r.body.code;
        if (code === 'limit_reached') toast(action === 'humanizer' ? MSG.limit_humanizer : MSG.limit_detector);
        else showMessage(friendly(code), code !== 'invalid_action');
      }
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
    X.prototype.send = function () {
      var self = this, args = arguments;
      if (!self.__genzAction) return oSend.apply(self, args);
      consume(self.__genzAction).then(function (ok) { if (ok) oSend.apply(self, args); else { try { self.abort(); } catch (e) {} } });
    };
  }

  // ── Hide pricing / billing / upgrade / account UI only ──────────────────────────
  var HIDE_RE = /upgrade|pricing|billing|subscription|subscribe|manage plan|my account|account settings|payment|invoice/i;
  function hideBillingUI(root) {
    var nodes = (root || document).querySelectorAll('a,button,[role="button"],li,nav a');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]; if (n.__genzChecked) continue; n.__genzChecked = true;
      var txt = (n.textContent || '').trim();
      var href = (n.getAttribute && (n.getAttribute('href') || '')) || '';
      if (txt && txt.length < 40 && (HIDE_RE.test(txt) || HIDE_RE.test(href))) n.style.setProperty('display', 'none', 'important');
    }
  }

  // ── Capture mode (admin) ─────────────────────────────────────────────────────
  function buildCaptureUI() {
    var w = document.createElement('div');
    w.id = 'genz-sw-widget';
    w.innerHTML =
      '<div class="genz-sw-head"><span class="genz-sw-brand">Gen Z · Capture</span></div>' +
      '<div class="genz-sw-body"><div class="genz-sw-msg" style="display:block">Log in to your StealthWriter account, then save the session.</div>' +
      '<button class="genz-sw-support" id="genz-sw-save" style="border:0;cursor:pointer">💾 Save session to vault</button></div>';
    document.documentElement.appendChild(w);
    var btn = w.querySelector('#genz-sw-save');
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Saving…';
      fetch('/__genz/save-session', { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) { if (j && j.ok) { btn.textContent = '✓ Saved'; toast('Session saved. You can close this tab.'); } else { btn.disabled = false; btn.textContent = '💾 Save session to vault'; toast('Could not save — make sure you are logged in first.'); } })
        .catch(function () { btn.disabled = false; btn.textContent = '💾 Save session to vault'; toast('Save failed.'); });
    });
  }

  function start() {
    if (!LEASE) { buildWidget(); showMessage(MSG.lease_missing, true); return; }
    if (CFG.capture) { buildCaptureUI(); return; }
    buildWidget();
    hideBillingUI(document);
    var mo = new MutationObserver(function (muts) { for (var i = 0; i < muts.length; i++) for (var j = 0; j < muts[i].addedNodes.length; j++) { var n = muts[i].addedNodes[j]; if (n.nodeType === 1) hideBillingUI(n); } });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    validate();
    setInterval(tick, 1000);
    setInterval(validate, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
