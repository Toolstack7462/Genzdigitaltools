/* Gen Z StealthWriter overlay — injected into the proxied StealthWriter app.
 *
 * 1) Small bottom-right floating glass widget: "Gen Z Digital Store" title with a
 *    "StealthWriter" subtitle, Humanizer remaining/total, AI Detector remaining/total,
 *    session time left and a Contact-support button. Collapsible. No top bar, never
 *    covers the editor/buttons.
 * 2) Intent-driven usage metering: Genz usage is counted ONLY when the user clicks the
 *    MAIN "Humanize" or "Check for AI" button. The action comes from the click (not the
 *    request URL), so AI Detector counts correctly even when it shares an endpoint with
 *    Humanizer. Result-area secondary actions (Humanize More, Rehumanize, Copy, Compare,
 *    Deep Scan, …) never consume usage.
 * 3) Account / branding chrome is HIDDEN COMPLETELY (not re-branded). Wherever the
 *    StealthWriter account name / email / initials / avatar / profile-dropdown trigger
 *    is shown (the top account/branding bar AND the bottom-left sidebar account area),
 *    the whole control is removed from view — nothing, not even "Gen Z Digital Store",
 *    is shown in those areas. Plan / billing / subscription / pricing / FAQ / support /
 *    Discord / affiliate / settings / log out and StealthWriter's own usage counters
 *    are hidden too, so the sidebar shows only Dashboard / Humanizer / AI Detector.
 *    The Gen Z brand lives ONLY in the small bottom-right floating widget.
 *    SPA-safe (MutationObserver + route hooks). Never hides the working area
 *    (textarea, Humanize, Check for AI, result area).
 *    Raw upstream "Forbidden"/error text → friendly widget message.
 *
 * NO-FLASH: the static hide rules ship as critical CSS in <head> (server-injected,
 * see server.js buildCriticalCss) and this script is inlined in <head> too, so its
 * MutationObserver starts hiding text-matched nodes before <body> first paints. The
 * MutationObserver / interval are only a backup for SPA re-renders.
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

  // ── Floating widget — compact: title + 2 usage lines + session + support ─────
  function buildWidget() {
    var w = document.createElement('div');
    w.id = 'genz-sw-widget';
    w.innerHTML =
      '<div class="genz-sw-head">' +
        '<div class="genz-sw-brandwrap">' +
          '<span class="genz-sw-title">Gen Z Digital Store</span>' +
          '<span class="genz-sw-sub">StealthWriter</span>' +
        '</div>' +
        '<button class="genz-sw-min" title="Minimize" aria-label="Minimize">–</button>' +
      '</div>' +
      '<div class="genz-sw-body">' +
        '<div class="genz-sw-row"><span>Humanizer</span><b><i id="genz-h-rem">–</i> / <i id="genz-h-total">–</i></b></div>' +
        '<div class="genz-sw-row"><span>AI Detector</span><b><i id="genz-d-rem">–</i> / <i id="genz-d-total">–</i></b></div>' +
        '<div class="genz-sw-row genz-sw-cd"><span>Session</span><b id="genz-sw-time">--:--</b></div>' +
        '<div class="genz-sw-msg" id="genz-sw-msg"></div>' +
        '<a class="genz-sw-support" href="' + SUPPORT_URL + '" target="_blank" rel="noopener" title="Contact support">Contact support</a>' +
      '</div>';
    document.documentElement.appendChild(w);
    el.widget = w; el.time = w.querySelector('#genz-sw-time'); el.msg = w.querySelector('#genz-sw-msg');
    el.hTotal = w.querySelector('#genz-h-total'); el.hRem = w.querySelector('#genz-h-rem');
    el.dTotal = w.querySelector('#genz-d-total'); el.dRem = w.querySelector('#genz-d-rem');
    el.min = w.querySelector('.genz-sw-min'); el.head = w.querySelector('.genz-sw-head');
    el.min.addEventListener('click', toggleCollapse);
    el.head.addEventListener('click', function (e) { if (state.collapsed && e.target !== el.min) toggleCollapse(); });
  }
  function toggleCollapse() { state.collapsed = !state.collapsed; el.widget.classList.toggle('genz-sw-collapsed', state.collapsed); el.min.textContent = state.collapsed ? '+' : '–'; }
  function render() { if (!el.widget) return; el.time.textContent = fmtTime(state.secondsRemaining); el.widget.classList.toggle('genz-sw-warn', state.secondsRemaining <= 60 && !state.terminal); el.widget.classList.toggle('genz-sw-error', !!state.terminal); }

  // Daily usage from the Genz backend. Limit -1 = unlimited; remaining null = unlimited.
  function fmtLimit(n) { return (n == null || Number(n) < 0) ? '∞' : String(n); }
  function updateUsage(plan) {
    if (!el.widget || !plan) return;
    var lim = plan.limits || {}, rem = plan.remaining || {};
    if (el.hTotal) el.hTotal.textContent = fmtLimit(lim.humanizer);
    if (el.hRem) el.hRem.textContent = fmtLimit(rem.humanizer);
    if (el.dTotal) el.dTotal.textContent = fmtLimit(lim.detector);
    if (el.dRem) el.dRem.textContent = fmtLimit(rem.detector);
  }
  function showMessage(text, terminal) { if (!el.msg) return; el.msg.textContent = text; el.msg.style.display = text ? 'block' : 'none'; if (terminal) { state.terminal = true; if (state.collapsed) toggleCollapse(); } render(); }
  function clearMessage() { if (el.msg) { el.msg.textContent = ''; el.msg.style.display = 'none'; } }
  // Shown when a raw upstream "Forbidden"/error page slips into the client view.
  function showFriendlyError() { if (state.friendlyShown) return; state.friendlyShown = true; showMessage(MSG.unavailable, false); }
  function toast(text) { var t = document.createElement('div'); t.className = 'genz-sw-toast'; t.textContent = text; document.documentElement.appendChild(t); setTimeout(function () { t.classList.add('genz-sw-toast-out'); }, 2800); setTimeout(function () { t.remove(); }, 3400); }

  function apiCall(endpoint, payload) {
    return fetch(API + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + (LEASE || '') }, body: JSON.stringify(payload || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); });
  }

  function validate() {
    if (state.terminal) return Promise.resolve();
    return apiCall('/validate', {}).then(function (r) {
      if (r.status === 200 && r.body && r.body.valid) { state.secondsRemaining = r.body.secondsRemaining || 0; updateUsage(r.body.plan); clearMessage(); render(); }
      else showMessage(friendly(r.body && r.body.code), true);
    }).catch(function () {});
  }
  function tick() { if (state.terminal) return; state.secondsRemaining -= 1; if (state.secondsRemaining <= 0) validate(); render(); }

  // ── Usage metering — INTENT-DRIVEN ─────────────────────────────────────────
  // Genz usage counts ONLY for the MAIN "Humanize" / "Check for AI" actions in the
  // input area — never for result-area secondary buttons (Humanize More, Rehumanize,
  // Copy, Compare, Deep Scan, etc.). A recognised MAIN-button click arms a short-lived
  // intent; the very next real mutating request (POST/PUT/PATCH to StealthWriter, not a
  // static asset or our own API) consumes ONE unit of that intent's action and clears
  // it. The action is taken from the CLICK, not from the request URL, so AI Detector is
  // counted correctly even though Humanizer and Detector share request endpoints.

  // Map a clicked control's text to a MAIN billable action, or null (not billable).
  // Non-billable controls are checked FIRST so "Humanize More" / "Rehumanize" /
  // result-area buttons never arm an intent even though they contain "humanize".
  var SECONDARY_RE = /humanize\s*more|re-?humanize|humanize\s*again|^copy\b|^compare\b|deep\s*scan|^paste\b|^retry\b|^regenerate\b|^share\b|^download\b|^export\b|^clear\b|^undo\b/i;
  // Main actions: word-boundary "humanize" (so the sidebar "Humanizer" label and
  // "Rehumanize" do NOT match) and the "Check for AI" detector button.
  var MAIN_HUMANIZE_RE = /\bhumanise\b|\bhumanize\b/i;
  var MAIN_DETECT_RE   = /check\s*(for\s*)?ai\b|detect\s*ai\b|scan\s*for\s*ai\b/i;
  function classifyClick(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40) return null;
    if (SECONDARY_RE.test(t)) return null;        // never count secondary buttons
    if (MAIN_DETECT_RE.test(t)) return 'detector';
    if (MAIN_HUMANIZE_RE.test(t)) return 'humanizer';
    return null;
  }

  // Short-lived intent: a recognised main click arms one billable request.
  var INTENT_TTL = 6000;
  var intent = { action: null, at: 0 };
  function armIntent(action) { intent.action = action; intent.at = Date.now(); }
  // Take the armed action if still fresh. The request URL is NOT used to decide the
  // action — the click already told us which action it is.
  function takeIntent() {
    if (!intent.action) return null;
    if (Date.now() - intent.at > INTENT_TTL) { intent.action = null; return null; }
    var a = intent.action;
    intent.action = null; // each main click counts at most once
    return a;
  }
  // A request that should consume usage: a mutating call to StealthWriter itself,
  // not our own API and not a static asset.
  function isCountableRequest(method, url) {
    if (!url || url.indexOf(API) === 0) return false;
    if (['POST', 'PUT', 'PATCH'].indexOf(String(method || 'GET').toUpperCase()) < 0) return false;
    if (/\.(js|css|mjs|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|ico|map)(\?|#|$)/i.test(url)) return false;
    return true;
  }
  // Capture-phase click listener: arm intent from the clicked control's label.
  document.addEventListener('click', function (e) {
    var n = e.target;
    var ctrl = n && n.closest ? n.closest('button,[role="button"],a,input[type="submit"],input[type="button"]') : null;
    if (!ctrl || (ctrl.closest && ctrl.closest('#genz-sw-widget'))) return;
    var label = (ctrl.textContent || ctrl.value || ctrl.getAttribute('aria-label') || '').trim();
    var action = classifyClick(label);
    if (action) armIntent(action);
  }, true);

  function consume(action) {
    return apiCall('/consume', { action: action }).then(function (r) {
      if (r.body && typeof r.body.secondsRemaining === 'number') { state.secondsRemaining = r.body.secondsRemaining; render(); }
      // Reflect the new remaining count live for the consumed action.
      if (r.body && r.body.remaining) {
        var rem = r.body.remaining;
        if (action === 'humanizer' && el.hRem) el.hRem.textContent = fmtLimit(rem.humanizer);
        if (action === 'detector' && el.dRem) el.dRem.textContent = fmtLimit(rem.detector);
      }
      var allowed = !!(r.body && r.body.allowed);
      if (!allowed) { var code = r.body && r.body.code; if (code === 'limit_reached') toast(action === 'humanizer' ? MSG.limit_humanizer : MSG.limit_detector); else showMessage(friendly(code), code !== 'invalid_action'); }
      return allowed;
    }).catch(function () { return false; });
  }
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var method = (init && init.method) || (typeof input === 'object' && input && input.method) || 'GET';
      // Count only when a mutating request follows a recognised MAIN-button click;
      // secondary buttons never arm an intent, so they pass through free.
      if (!intent.action || !isCountableRequest(method, url)) return origFetch(input, init);
      var action = takeIntent();
      if (!action) return origFetch(input, init);
      return consume(action).then(function (ok) { if (!ok) return Promise.reject(new Error('GENZ_LIMIT_BLOCKED')); return origFetch(input, init); });
    };
  }
  var X = window.XMLHttpRequest;
  if (X) {
    var oOpen = X.prototype.open, oSend = X.prototype.send;
    X.prototype.open = function (method, url) { this.__genzMethod = method; this.__genzUrl = url || ''; return oOpen.apply(this, arguments); };
    X.prototype.send = function () {
      var self = this, args = arguments;
      if (!intent.action || !isCountableRequest(self.__genzMethod, self.__genzUrl)) return oSend.apply(self, args);
      var action = takeIntent();
      if (!action) return oSend.apply(self, args);
      consume(action).then(function (ok) { if (ok) oSend.apply(self, args); else { try { self.abort(); } catch (e) {} } });
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VISUAL HIDING of account / plan / pricing / FAQ / support / Discord / affiliate /
  // subscription UI and StealthWriter's own usage counters. SPA-safe. Cosmetic only.
  // ════════════════════════════════════════════════════════════════════════════
  // Hide these labels (exact-ish short text on links/buttons/nav items).
  var HIDE_RE = /^(account|my account|account settings|account details|profile|my profile|settings|preferences|log\s?out|sign\s?out|logout|plans?\s*&?\s*pricing|pricing|faq|faqs|help|help center|support|contact us|discord|community|affiliate|affiliate program|refer|refer a friend|invite friends?|earn|rewards|subscription|manage subscription|billing|manage plan|upgrade|upgrade plan|get more|get started|starter plan|free plan|basic plan|pro plan|premium( plan)?|enterprise)$/i;
  // Hide StealthWriter's own usage/reset counters.
  var USAGE_RE = /(\d+\s*\/\s*\d+\s*(humaniz|scan|word|credit)|humanizations?\s+left|scans?\s+left|words?\s+left|credits?\s+left|resets?\s+(in|at|on|every|daily|tomorrow)|words?\s+remaining|usage\s+resets)/i;
  // Hide the StealthWriter account identity (email / signed-in user) shown in the
  // top/right header so the client's own StealthWriter email/name is never visible.
  var EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  // Raw upstream error text that must never reach the client verbatim.
  var FORBIDDEN_RE = /^(forbidden|403\s*forbidden|403|access denied|unauthorized|401)\.?$/i;
  // NEVER hide the working area / allowed nav.
  var KEEP_RE = /^(dashboard|humanizer|ai detector|ai-detector|humanize|check for ai|detect ai|paraphrase|input|output|copy|paste|new|history|home)$/i;

  function ownText(n) { var s = ''; for (var i = 0; i < n.childNodes.length; i++) { var c = n.childNodes[i]; if (c.nodeType === 3) s += c.nodeValue; } return s.trim(); }
  function hasEditor(n) { return !!(n.querySelector && n.querySelector('textarea,[contenteditable="true"],input')); }
  function hide(n) { if (n && n.style && n.id !== 'genz-sw-widget') { n.style.setProperty('display', 'none', 'important'); n.setAttribute('data-genz-hidden', '1'); } }
  function nearestControl(n) { var d = 0, c = n; while (c && d < 4) { var tag = (c.tagName || '').toLowerCase(); if (tag === 'a' || tag === 'button' || tag === 'li' || (c.getAttribute && c.getAttribute('role') === 'button')) return c; c = c.parentElement; d++; } return n; }

  // ── Account / identity controls → HIDDEN COMPLETELY ─────────────────────────
  // Wherever the StealthWriter account name / email / avatar / profile trigger is
  // visible — the top account/branding bar AND the bottom-left sidebar account area —
  // hide the whole control. Nothing is shown in its place; the Gen Z brand lives only
  // in the floating widget. Never reads or logs the identity values.
  var AVATAR_SEL = '[class*="avatar" i],[class*="initial" i],[class*="userpic" i],[data-avatar]';
  // An account/identity trigger detected structurally (avatar / initials / aria label)
  // even when it shows no visible email — lets us hide the bottom-left sidebar account
  // area where the email only appears inside the dropdown.
  function isIdentityControl(n) {
    if (!n || hasEditor(n)) return false;
    // Strong trigger signal: it contains a user avatar / initials element.
    if (n.querySelector && n.querySelector(AVATAR_SEL)) return true;
    var a = ((n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('data-testid') || '')) || '').toLowerCase();
    if (/(^|[\s_-])(user[\s_-]?menu|usermenu|avatar|account|profile|my[\s_-]?account)([\s_-]|$)/.test(a)) return true;
    return false;
  }

  function sweep(root) {
    var nodes;
    try { nodes = (root && root.querySelectorAll ? root : document).querySelectorAll('a,button,[role="button"],li,span,div,p,h1,h2,h3,h4'); } catch (e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.__genz || n.id === 'genz-sw-widget' || (n.closest && n.closest('#genz-sw-widget'))) continue;
      n.__genz = true;
      // Account/identity trigger (avatar/initials/aria) — brand even with no visible
      // text. Only act on actual controls so nav items / working area are untouched.
      var ctag = (n.tagName || '').toLowerCase();
      if ((ctag === 'button' || ctag === 'a' || (n.getAttribute && n.getAttribute('role') === 'button')) && isIdentityControl(n)) {
        hide(n); continue;                       // account/identity trigger → hide completely
      }
      var t = ownText(n);
      if (!t || t.length > 60) continue;
      if (KEEP_RE.test(t)) continue;            // protect Dashboard/Humanizer/AI Detector/buttons
      if (hasEditor(n)) continue;               // never hide a container with the editor
      if (FORBIDDEN_RE.test(t)) { showFriendlyError(); hide(nearestControl(n)); continue; } // raw upstream error → friendly
      if (EMAIL_RE.test(t)) { hide(nearestControl(n)); continue; } // account name/email → hide the whole control
      if (HIDE_RE.test(t)) { hide(nearestControl(n)); continue; }   // account/plan/pricing/etc → hide the whole control
      if (USAGE_RE.test(t)) { hide(n); }         // StealthWriter usage/reset counters → hide the label
    }
  }

  // href / aria based hiding (robust against obfuscated class names) via injected CSS.
  // The server already ships these as critical CSS (#genz-critical-hide) in <head>;
  // this is a backup so the overlay still hides them if the script is loaded stand-alone.
  function injectHideStyle() {
    if (document.getElementById('genz-critical-hide') || document.getElementById('genz-sw-hide')) return;
    var hrefs = ['pricing', 'billing', 'account', 'affiliate', 'discord', '/faq', 'support',
      'subscription', 'upgrade', 'refer', 'plans', '/settings', '/profile', '/me',
      'logout', 'log-out', 'sign-out', 'signout'];
    var css = hrefs.map(function (h) { return 'a[href*="' + h + '"]'; }).join(',') +
      ',[data-genz-hidden="1"]{display:none !important;}';
    var s = document.createElement('style'); s.id = 'genz-sw-hide'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  function runHiding() { try { sweep(document); } catch (e) {} }

  // ── Hiding starts IMMEDIATELY (no DOMContentLoaded wait) ────────────────────
  // Because this script is inlined in <head>, registering the MutationObserver here
  // means account/branding nodes are hidden as React inserts them — before <body>
  // first paints — so there is no flash. The observer + interval remain as a backup
  // for SPA soft-navigations / re-renders.
  function startHiding() {
    injectHideStyle();
    runHiding();
    // Debounce the observer so a burst of React mutations triggers ONE sweep on the
    // next frame, not a full-document sweep per mutation (avoids jank on heavy pages).
    var scheduled = false;
    function scheduleHiding() {
      if (scheduled) return; scheduled = true;
      var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      raf(function () { scheduled = false; runHiding(); });
    }
    var mo = new MutationObserver(scheduleHiding);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    var _ps = history.pushState; history.pushState = function () { var r = _ps.apply(this, arguments); setTimeout(runHiding, 60); return r; };
    window.addEventListener('popstate', function () { setTimeout(runHiding, 60); });
    setInterval(runHiding, 1500);
  }

  // ── Widget + metering: needs <body>, so it waits for DOMContentLoaded ───────
  function startWidget() {
    if (!LEASE) { buildWidget(); showMessage(MSG.lease_missing, true); return; }
    if (CFG.capture) { buildCaptureUI(); return; }
    buildWidget();
    validate();
    setInterval(tick, 1000);
    setInterval(validate, 30000);
  }

  function start() {
    // Hiding can begin before the body exists; only real client views hide chrome.
    if (LEASE && !CFG.capture) startHiding();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startWidget);
    else startWidget();
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

  // Run immediately — start() begins hiding now (script is inlined in <head>) and
  // internally defers only the widget build until the DOM is ready.
  start();
})();
