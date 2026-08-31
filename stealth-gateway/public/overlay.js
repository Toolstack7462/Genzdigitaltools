/* Gen Z StealthWriter overlay — injected into the proxied StealthWriter app.
 *
 * 1) Small bottom-right floating glass widget: "Gen Z Digital Store" title with a
 *    "StealthWriter" subtitle, Humanizer remaining/total, AI Detector remaining/total,
 *    session time left and a Contact-support button. Collapsible. No top bar, never
 *    covers the editor/buttons.
 * 2) Usage metering — RESERVED then COMMITTED ONLY ON A VERIFIED RESULT. A click on the
 *    MAIN "Humanize" / "Check for AI" button reserves one credit and tags that one
 *    request with an opaque operation id; the GATEWAY then commits or cancels it from
 *    StealthWriter's real response. A high-demand error, a network failure, an abort or
 *    an empty result therefore costs nothing. The action still comes from the CLICK (not
 *    the request URL), so AI Detector counts correctly even when it shares an endpoint
 *    with Humanizer, and result-area secondary actions (Humanize More, Rehumanize, Copy,
 *    Compare, Deep Scan, …) never meter at all.
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
  var ACCOUNT_LABEL = CFG.accountLabel || '';   // safe operator label (no secrets); '' = hide row
  var SUPPORT_URL = CFG.support || 'https://app.genzdigitalstore.com/client/dashboard';
  if (!API) return;

  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }
  // ── How this overlay authenticates ──────────────────────────────────────────
  // SAME-ORIGIN MODE (CFG.sameOrigin, the current gateway): the lease lives ONLY in an
  // HttpOnly `__Host-stealth_session` cookie that page script deliberately cannot read. We
  // call the gateway's own /__genz/validate and /__genz/usage/* with credentials:'same-origin'
  // — the cookie rides along automatically and the server attaches the lease on our behalf.
  // Request/response shapes are identical to the direct backend calls, so metering, limits
  // and messages are unchanged.
  //
  // LEGACY MODE (older gateway build): read the JS-readable `sw_lease` cookie and send it to
  // the backend as a Bearer token. Kept only so a cached overlay from a previous deploy still
  // works during a rollout; nothing mints that cookie any more.
  var SAME_ORIGIN = !!CFG.sameOrigin; // eslint-disable-line no-unused-vars — read below
  var LEASE = SAME_ORIGIN ? null : getCookie('sw_lease');
  // In same-origin mode the absence of a readable lease says NOTHING about whether a session
  // exists, so "do we have access?" must be answered by the server, never by a cookie read.
  var HAS_SESSION = SAME_ORIGIN ? true : !!LEASE;

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
    busy:            'A Humanize or AI check is already running. Please wait for it to finish.',
    reserve_offline: "Couldn't reach Gen Z Digital Store. Nothing was used \u2014 please try again in a moment.",
  };
  function friendly(code) {
    if (MSG[code]) return MSG[code];
    if (code === 'account_blocked' || code === 'account_no_session' || code === 'client_not_found') return MSG.no_account;
    return MSG.unavailable;
  }

  // Shown INSTEAD of a terminal error while validation is failing for infrastructure
  // reasons (network, timeout, 429, 5xx, malformed body). The session keeps running.
  var MSG_RETRYING = 'Connection interrupted — retrying…';

  // Confirmed authorization denials. ONLY these end a session. Mirrors the closed list in
  // backend/utils/proxy/validationResponse.js — anything else is transient by definition.
  var TERMINAL_CODES = {
    lease_expired: 1, lease_revoked: 1, lease_invalid: 1, lease_missing: 1,
    client_disabled: 1, client_not_found: 1, plan_expired: 1,
    account_blocked: 1, account_no_session: 1
  };

  // How long a session may coast on the last SUCCESSFUL validation while the backend is
  // unreachable. Bounded: an expired or revoked lease can never be extended by it, because
  // the countdown below is driven by the server-issued absolute expiry, which keeps
  // running during the outage and ends the session on time regardless.
  var GRACE_MS = (typeof CFG.validateGraceMs === 'number' ? CFG.validateGraceMs : 120000);

  var state = {
    secondsRemaining: 0,
    expiresAtMs: 0,        // absolute server-issued deadline; 0 = not yet known
    skewMs: 0,             // serverTime - clientTime, so a wrong device clock cannot freeze or extend the countdown
    terminal: false,
    collapsed: false,
    degraded: false,       // a retryable failure is currently being shown
    failures: 0,           // consecutive retryable failures (drives backoff)
    lastGoodAt: 0,
    inFlight: false,       // guards against overlapping validations corrupting state
    retryTimer: null
  };
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
        '<div class="genz-sw-row genz-sw-acct" id="genz-sw-acct-row" style="display:none"><span>Account</span><b id="genz-sw-acct"></b></div>' +
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
    if (ACCOUNT_LABEL) {                                     // show which account is in use (safe label)
      var acctRow = w.querySelector('#genz-sw-acct-row');
      w.querySelector('#genz-sw-acct').textContent = ACCOUNT_LABEL; // textContent → no HTML injection
      acctRow.style.display = '';
    }
    el.min.addEventListener('click', toggleCollapse);
    el.head.addEventListener('click', function (e) { if (state.collapsed && e.target !== el.min) toggleCollapse(); });
  }
  function toggleCollapse() { state.collapsed = !state.collapsed; el.widget.classList.toggle('genz-sw-collapsed', state.collapsed); el.min.textContent = state.collapsed ? '+' : '–'; }
  function render() { if (!el.widget) return; el.time.textContent = fmtTime(state.secondsRemaining); el.widget.classList.toggle('genz-sw-warn', state.secondsRemaining <= 60 && !state.terminal); el.widget.classList.toggle('genz-sw-error', !!state.terminal); el.widget.classList.toggle('genz-sw-degraded', !!state.degraded && !state.terminal); }

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

  // Safe client diagnostics — console only, and ONLY tool/route/status/code/latency style
  // fields. Never the lease token, cookies, account session or any credential.
  function log(evt, fields) {
    try {
      var safe = { evt: evt, tool: CFG.tool || null };
      for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) safe[k] = fields[k];
      if (window.console && console.debug) console.debug('[genz]', JSON.stringify(safe));
    } catch (_) {}
  }

  function apiCall(endpoint, payload) {
    var startedAt = Date.now();
    // Same-origin: no Authorization header exists to send — the HttpOnly session cookie is
    // the credential, and the gateway relays the backend's answer byte-for-byte.
    var url = SAME_ORIGIN ? ('/__genz' + endpoint) : (API + endpoint);
    var opts = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    };
    if (SAME_ORIGIN) opts.credentials = 'same-origin';
    else opts.headers.authorization = 'Bearer ' + (LEASE || '');
    return fetch(url, opts)
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j, latencyMs: Date.now() - startedAt }; }); });
  }

  // ── Validation: permanent denial vs. temporary infrastructure failure ───────
  // A non-200 alone means nothing. Only a CONFIRMED code from the list above ends the
  // session; everything else (network error, timeout, 429, 5xx, malformed JSON) keeps the
  // session alive and retries with bounded exponential backoff + jitter.
  function isTerminalResponse(r) {
    if (!r || !r.body) return false;
    if (r.body.terminal === true) return true;      // server said so explicitly
    if (r.body.retryable === true) return false;    // …or said the opposite
    return !!TERMINAL_CODES[r.body.code];           // legacy backend: classify by code
  }

  // Absolute deadline wins over any local counter, so the countdown can never freeze on a
  // stale value and never drifts. serverTime corrects a wrong device clock.
  function adoptExpiry(body) {
    var now = Date.now();
    if (body && body.serverTime) {
      var st = Date.parse(body.serverTime);
      if (!isNaN(st)) state.skewMs = st - now;
    }
    if (body && body.expiresAt) {
      var exp = Date.parse(body.expiresAt);
      if (!isNaN(exp)) { state.expiresAtMs = exp; return; }
    }
    // Older backend without expiresAt — derive an absolute deadline from the relative value.
    if (body && typeof body.secondsRemaining === 'number') {
      state.expiresAtMs = now + state.skewMs + (body.secondsRemaining * 1000);
    }
  }
  function computeRemaining() {
    if (!state.expiresAtMs) return state.secondsRemaining;
    return Math.max(0, Math.round((state.expiresAtMs - (Date.now() + state.skewMs)) / 1000));
  }

  function onRetryableFailure(why) {
    state.failures += 1;
    // Within the grace period a brief blip stays silent; past it, show the compact warning.
    // Never terminal, so tick() keeps counting and validation keeps retrying.
    if (!state.lastGoodAt || (Date.now() - state.lastGoodAt) > GRACE_MS) {
      state.degraded = true;
      showMessage(MSG_RETRYING, false);
    }
    log('validate_retryable', { reason: why, failures: state.failures });
    scheduleRetry();
  }
  // Exponential backoff with jitter, capped — 2s, 4s, 8s … 30s max.
  function scheduleRetry() {
    if (state.terminal || state.retryTimer) return;
    var base = Math.min(30000, 2000 * Math.pow(2, Math.min(state.failures - 1, 4)));
    var delay = base * (0.7 + Math.random() * 0.6); // ±30% jitter avoids synchronized retry storms
    state.retryTimer = setTimeout(function () { state.retryTimer = null; validate(); }, delay);
  }

  function validate() {
    if (state.terminal) return Promise.resolve();
    if (state.inFlight) return Promise.resolve();   // concurrent calls must not corrupt state
    state.inFlight = true;
    return apiCall('/validate', {}).then(function (r) {
      state.inFlight = false;
      if (r.status === 200 && r.body && r.body.valid) {
        adoptExpiry(r.body);
        updateUsage(r.body.plan);   // StealthWriter-only: refresh the Humanizer/Detector counters
        state.secondsRemaining = computeRemaining();
        state.failures = 0; state.lastGoodAt = Date.now();
        if (state.degraded) { state.degraded = false; }  // auto-clear the warning on recovery
        clearMessage(); render();
        return;
      }
      if (isTerminalResponse(r)) {                   // confirmed denial — stop, as before
        log('validate_terminal', { code: (r.body && r.body.code) || null, status: r.status });
        showMessage(friendly(r.body && r.body.code), true);
        return;
      }
      onRetryableFailure('status_' + r.status);      // 429 / 5xx / malformed body / unknown code
    }).catch(function (e) {
      state.inFlight = false;
      onRetryableFailure('network');                 // fetch rejected: offline, DNS, TLS, CORS
    });
  }
  function tick() {
    if (state.terminal) return;
    state.secondsRemaining = state.expiresAtMs ? computeRemaining() : Math.max(0, state.secondsRemaining - 1);
    if (state.secondsRemaining <= 0) validate();
    render();
  }

  // ── Usage metering — INTENT-DRIVEN, CHARGED ONLY ON A VERIFIED RESULT ──────
  // Genz usage applies ONLY to the MAIN "Humanize" / "Check for AI" actions in the
  // input area — never to result-area secondary buttons (Humanize More, Rehumanize,
  // Copy, Compare, Deep Scan, etc.), which matches StealthWriter's own billing.
  // A recognised MAIN-button click arms a short-lived intent; the very next real
  // mutating request (POST/PUT/PATCH to StealthWriter, not a static asset and not our
  // own /__genz API) RESERVES one unit of that intent's action and carries the
  // reservation id. Nothing is spent until the gateway has seen StealthWriter answer
  // with an actual result. The action is taken from the CLICK, not from the request
  // URL, so AI Detector counts correctly even though the two share request endpoints.

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
  // A request that should meter usage: a mutating call to StealthWriter itself,
  // not our own API and not a static asset.
  function isCountableRequest(method, url) {
    if (!url || url.indexOf(API) === 0) return false;
    if (/^\/__genz\//.test(String(url)) || /\/__genz\//.test(String(url))) return false; // our own gateway API
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

  // ── Reserve → dispatch → the GATEWAY commits or cancels ────────────────────
  // Usage is no longer spent on the click. A recognised MAIN-button click RESERVES one
  // credit (capacity is held; the visible counter does not move), the reserved request is
  // tagged with an opaque operation id, and the gateway decides from StealthWriter's real
  // response whether that credit is committed or released.
  //
  // This overlay never declares success. /__genz/usage/commit refuses a browser caller
  // outright, so a page script — ours included — cannot turn a loading spinner into a
  // charge. All it can do is reserve, tag, and release.
  var OP_HEADER = 'X-Genz-Op';
  var ACTION_HEADER = 'X-Genz-Action';

  // One billable operation at a time. The backend enforces this too (one in-flight
  // operation per client + action); this just gives a friendly answer without a round trip.
  var opState = { busy: false };
  function releaseBusy() { opState.busy = false; }

  // The counters are authoritative on the server and are committed only AFTER the response
  // completes, so re-read them from /validate a moment later rather than guessing locally.
  // Twice, cheaply, so a slow commit still lands on the widget.
  function refreshUsageSoon() {
    setTimeout(function () { validate(); }, 1200);
    setTimeout(function () { validate(); }, 4000);
  }

  function reserveOp(action) {
    if (opState.busy) { toast(MSG.busy); return Promise.resolve(null); }
    opState.busy = true;
    return apiCall('/usage/reserve', { action: action }).then(function (r) {
      if (r.body && typeof r.body.secondsRemaining === 'number') { state.secondsRemaining = r.body.secondsRemaining; render(); }
      var op = r.body && r.body.operationId;
      var allowed = !!(r.body && (r.body.ok || r.body.allowed)) && typeof op === 'string' && op.length > 0;
      if (!allowed) {
        releaseBusy();
        var code = (r.body && r.body.code) || 'unavailable';
        if (code === 'limit_reached') toast(action === 'humanizer' ? MSG.limit_humanizer : MSG.limit_detector);
        else if (code === 'operation_in_flight') toast(MSG.busy);
        else if (code === 'backend_unavailable' || code === 'rate_limited' || code === 'server_error') toast(MSG.reserve_offline);
        else if (code !== 'invalid_action') showMessage(friendly(code), !!TERMINAL_CODES[code]);
        log('usage_reserve_denied', { action_type: action, code: code, response_status: r.status });
        return null;
      }
      return op;
    }).catch(function () {
      // FAIL CLOSED — no reservation means the request must not be sent at all.
      releaseBusy();
      toast(MSG.reserve_offline);
      log('usage_reserve_failed', { action_type: action, reason: 'network' });
      return null;
    });
  }

  // Best-effort release when the failure is visible here first. The gateway cancels from
  // its own side too, and an undelivered cancel simply lets the reservation expire — it can
  // never turn into a charge.
  function cancelOp(op, action) {
    if (!op) return;
    apiCall('/usage/cancel', { action: action, operationId: op }).catch(function () {});
  }

  function isSameOrigin(url) {
    try { return new URL(String(url), location.href).origin === location.origin; }
    catch (_) { return false; }
  }

  // Attach the metering headers to exactly the reserved request. The gateway validates and
  // STRIPS every X-Genz-* header before forwarding, so none of this reaches StealthWriter.
  // If a request shape will not take extra headers we send it untagged: the reservation
  // then expires unused, which costs the member nothing.
  function withOpHeaders(input, init, op, action) {
    try {
      var isRequestObj = (typeof Request !== 'undefined') && (input instanceof Request);
      if (!isRequestObj) {
        var nextInit = {};
        for (var k in (init || {})) if (Object.prototype.hasOwnProperty.call(init, k)) nextInit[k] = init[k];
        var h = new Headers((init && init.headers) || {});
        h.set(OP_HEADER, op); h.set(ACTION_HEADER, action);
        nextInit.headers = h;
        return { input: input, init: nextInit };
      }
      var req = new Request(input, init || undefined);
      var hh = new Headers(req.headers);
      hh.set(OP_HEADER, op); hh.set(ACTION_HEADER, action);
      return { input: new Request(req, { headers: hh }), init: undefined };
    } catch (_) { return null; }
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
      return reserveOp(action).then(function (op) {
        if (!op) return Promise.reject(new Error('GENZ_LIMIT_BLOCKED'));
        var tagged = isSameOrigin(url) ? withOpHeaders(input, init, op, action) : null;
        var p = tagged ? origFetch(tagged.input, tagged.init) : origFetch(input, init);
        return p.then(function (resp) {
          releaseBusy(); refreshUsageSoon(); return resp;
        }, function (err) {
          // Network failure / abort seen in the page: release immediately, charge nothing.
          releaseBusy(); cancelOp(op, action); refreshUsageSoon();
          throw err;
        });
      });
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
      reserveOp(action).then(function (op) {
        if (!op) { try { self.abort(); } catch (e) {} return; }
        if (isSameOrigin(self.__genzUrl)) {
          try { self.setRequestHeader(OP_HEADER, op); self.setRequestHeader(ACTION_HEADER, action); } catch (e) {}
        }
        var done = false;
        function finish(failed) {
          if (done) return; done = true;
          releaseBusy();
          if (failed) cancelOp(op, action);
          refreshUsageSoon();
        }
        self.addEventListener('load', function () { finish(false); });
        self.addEventListener('error', function () { finish(true); });
        self.addEventListener('abort', function () { finish(true); });
        self.addEventListener('timeout', function () { finish(true); });
        oSend.apply(self, args);
      });
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
    // HAS_SESSION, not LEASE: in same-origin mode the lease is intentionally unreadable, so
    // only the server can say whether a session exists — validate() below asks it.
    if (!HAS_SESSION) { buildWidget(); showMessage(MSG.lease_missing, true); return; }
    if (CFG.capture) { buildCaptureUI(); return; }
    buildWidget();
    validate();
    setInterval(tick, 1000);
    setInterval(validate, 30000);
  }

  function start() {
    // Hiding can begin before the body exists; only real client views hide chrome.
    if (HAS_SESSION && !CFG.capture) startHiding();
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
