/* Gen Z StealthWriter usage overlay — injected into the proxied StealthWriter app.
 *
 * Responsibilities (the backend remains the single source of truth):
 *   - Show a small bar with plan name, remaining humanizer/detector limits and a
 *     30-minute countdown.
 *   - Re-validate the lease with the Genz backend periodically; block the page
 *     when the lease expires or is revoked.
 *   - Meter usage: intercept the app's own humanize / AI-detector network calls,
 *     ask the backend to consume one unit FIRST, and abort the call if the limit
 *     is reached. This metering is independent of the app's UI, so it cannot be
 *     bypassed by clicking around.
 *   - Visually hide pricing / billing / upgrade / account UI only.
 */
(function () {
  'use strict';
  var CFG = window.__GENZ_GATEWAY__ || {};
  var API = (CFG.api || '').replace(/\/$/, '');
  if (!API) return;

  // Action URL patterns — tune to the real StealthWriter API once known.
  var HUMANIZE_RE = CFG.humanizePattern ? new RegExp(CFG.humanizePattern, 'i') : /humaniz|rephrase|rewrite|paraphras/i;
  var DETECT_RE   = CFG.detectPattern   ? new RegExp(CFG.detectPattern, 'i')   : /detect|detector|ai-?score|ai-?check/i;

  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }
  var LEASE = getCookie('sw_lease');

  var state = { secondsRemaining: 0, remaining: { humanizer: null, detector: null }, plan: '', valid: false, blocked: false };

  function apiCall(endpoint, payload) {
    return fetch(API + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + (LEASE || '') },
      body: JSON.stringify(payload || {}),
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); });
  }

  // ── Overlay UI ──────────────────────────────────────────────────────────────
  var bar, elTime, elHum, elDet, elPlan, blockEl;
  function fmt(n) { return n === null || n === undefined ? '∞' : String(n); }
  function fmtTime(s) {
    if (s < 0) s = 0;
    var m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function buildBar() {
    bar = document.createElement('div');
    bar.id = 'genz-sw-bar';
    bar.innerHTML =
      '<span class="genz-sw-brand">Gen Z · StealthWriter</span>' +
      '<span class="genz-sw-plan" id="genz-sw-plan"></span>' +
      '<span class="genz-sw-sep"></span>' +
      '<span class="genz-sw-stat">Humanizer: <b id="genz-sw-hum">–</b></span>' +
      '<span class="genz-sw-stat">AI Detector: <b id="genz-sw-det">–</b></span>' +
      '<span class="genz-sw-sep"></span>' +
      '<span class="genz-sw-time">⏳ <b id="genz-sw-time">--:--</b></span>';
    document.documentElement.appendChild(bar);
    elTime = document.getElementById('genz-sw-time');
    elHum = document.getElementById('genz-sw-hum');
    elDet = document.getElementById('genz-sw-det');
    elPlan = document.getElementById('genz-sw-plan');
    document.body && (document.body.style.paddingTop = '38px');
  }
  function renderBar() {
    if (!bar) return;
    elTime.textContent = fmtTime(state.secondsRemaining);
    elHum.textContent = fmt(state.remaining.humanizer);
    elDet.textContent = fmt(state.remaining.detector);
    elPlan.textContent = state.plan || '';
    if (state.secondsRemaining <= 60) bar.classList.add('genz-sw-warn'); else bar.classList.remove('genz-sw-warn');
  }
  function showBlock(msg) {
    state.blocked = true;
    if (blockEl) { blockEl.querySelector('p').textContent = msg; return; }
    blockEl = document.createElement('div');
    blockEl.id = 'genz-sw-block';
    blockEl.innerHTML = '<div class="genz-sw-block-card"><h2>StealthWriter session ended</h2><p>' + msg + '</p>' +
      '<a href="https://app.genzdigitalstore.com/client/dashboard">Back to dashboard</a></div>';
    document.documentElement.appendChild(blockEl);
  }
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'genz-sw-toast';
    t.textContent = msg;
    document.documentElement.appendChild(t);
    setTimeout(function () { t.classList.add('genz-sw-toast-out'); }, 2600);
    setTimeout(function () { t.remove(); }, 3200);
  }

  var BLOCK_MSGS = {
    lease_expired: 'Your 30-minute session has ended. Reopen StealthWriter from your dashboard.',
    lease_revoked: 'Your session was ended by an administrator.',
    lease_invalid: 'Your session is invalid. Reopen StealthWriter from your dashboard.',
    lease_missing: 'No active session. Reopen StealthWriter from your dashboard.',
    client_disabled: 'Your StealthWriter access is disabled.',
    plan_expired: 'Your StealthWriter plan has expired.',
  };

  // ── Validation loop ───────────────────────────────────────────────────────────
  function validate() {
    return apiCall('/validate', {}).then(function (r) {
      if (r.status === 200 && r.body && r.body.valid) {
        state.valid = true;
        state.secondsRemaining = r.body.secondsRemaining || 0;
        state.remaining = (r.body.plan && r.body.plan.remaining) || state.remaining;
        state.plan = (r.body.plan && r.body.plan.planName) || state.plan;
        renderBar();
      } else {
        state.valid = false;
        showBlock(BLOCK_MSGS[r.body && r.body.code] || 'Your StealthWriter session is no longer valid.');
      }
    }).catch(function () { /* transient network error — keep last known state */ });
  }

  function tick() {
    if (state.blocked) return;
    state.secondsRemaining -= 1;
    if (state.secondsRemaining <= 0) { validate(); }
    renderBar();
  }

  // ── Usage metering: consume BEFORE the app's humanize/detect call proceeds ──────
  function actionFor(url) {
    if (HUMANIZE_RE.test(url)) return 'humanizer';
    if (DETECT_RE.test(url)) return 'detector';
    return null;
  }
  function consume(action) {
    return apiCall('/consume', { action: action }).then(function (r) {
      if (r.body) {
        if (r.body.remaining) state.remaining = r.body.remaining;
        if (typeof r.body.secondsRemaining === 'number') state.secondsRemaining = r.body.secondsRemaining;
        renderBar();
      }
      var allowed = !!(r.body && r.body.allowed);
      if (!allowed) {
        var code = r.body && r.body.code;
        if (code === 'limit_reached') toast('Daily ' + (action === 'humanizer' ? 'Humanizer' : 'AI Detector') + ' limit reached. Resets 5:00 AM PKT.');
        else if (BLOCK_MSGS[code]) showBlock(BLOCK_MSGS[code]);
        else toast('Action blocked.');
      }
      return allowed;
    }).catch(function () { return false; }); // fail closed on metering errors
  }

  // fetch() override
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      if (url.indexOf(API) === 0) return origFetch(input, init); // never gate our own calls
      var action = actionFor(url);
      if (!action) return origFetch(input, init);
      return consume(action).then(function (ok) {
        if (!ok) return Promise.reject(new Error('GENZ_LIMIT_BLOCKED'));
        return origFetch(input, init);
      });
    };
  }

  // XMLHttpRequest override
  var X = window.XMLHttpRequest;
  if (X) {
    var origOpen = X.prototype.open, origSend = X.prototype.send;
    X.prototype.open = function (method, url) {
      this.__genzUrl = url; this.__genzAction = (url && url.indexOf(API) !== 0) ? actionFor(url) : null;
      return origOpen.apply(this, arguments);
    };
    X.prototype.send = function (body) {
      var self = this, args = arguments;
      if (!self.__genzAction) return origSend.apply(self, args);
      consume(self.__genzAction).then(function (ok) {
        if (ok) return origSend.apply(self, args);
        try { self.dispatchEvent(new Event('error')); } catch (e) {}
        try { self.abort(); } catch (e) {}
      });
    };
  }

  // ── Hide pricing / billing / upgrade / account UI only ──────────────────────────
  var HIDE_RE = /upgrade|pricing|billing|subscription|subscribe|manage plan|my account|account settings|payment|invoice/i;
  function hideBillingUI(root) {
    var nodes = (root || document).querySelectorAll('a,button,[role="button"],li,nav a');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.__genzChecked) continue; n.__genzChecked = true;
      var txt = (n.textContent || '').trim();
      var href = (n.getAttribute && (n.getAttribute('href') || '')) || '';
      if (txt && txt.length < 40 && (HIDE_RE.test(txt) || HIDE_RE.test(href))) {
        n.style.setProperty('display', 'none', 'important');
      }
    }
  }

  function start() {
    if (!LEASE) { showBlock(BLOCK_MSGS.lease_missing); return; }
    buildBar();
    hideBillingUI(document);
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        for (var j = 0; j < muts[i].addedNodes.length; j++) {
          var node = muts[i].addedNodes[j];
          if (node.nodeType === 1) hideBillingUI(node);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    validate();
    setInterval(tick, 1000);
    setInterval(validate, 30000); // periodic re-validation catches revocation / limit changes
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
