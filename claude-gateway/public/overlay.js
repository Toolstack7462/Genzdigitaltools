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
  var ACCOUNT_LABEL = CFG.accountLabel || '';   // safe operator label (no secrets); '' = hide row
  var SUPPORT_URL = CFG.support || 'https://app.genzdigitalstore.com/client/dashboard';
  // Per-tool exact selectors from the gateway env (HIDE_SELECTORS). Already shipped in
  // the critical hide CSS server-side; re-applied here so SPA re-renders stay hidden.
  var HIDE_SELECTORS = (CFG.hideSelectors && CFG.hideSelectors.length) ? CFG.hideSelectors : [];
  if (!API) return;

  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }
  var LEASE = getCookie('pg_lease');

  // ── Service-worker neutralisation (CLAUDE ONLY) ─────────────────────────────
  // A service worker registered by the proxied app is scoped to THIS gateway origin and
  // serves navigations from ITS OWN Cache Storage. If it ever caches a Cloudflare
  // verification / "session ended" page, the browser keeps REPLAYING that cached page as
  // the application page on every later visit — the device never reaches the gateway, so
  // no server-side fix can dislodge it. Cache Storage also survives "clear cookies", which
  // is why a cookie reset does not recover the session. Desktop is typically unaffected
  // only because it never cached a broken page.
  //
  // We therefore (a) unregister any existing worker on this origin and delete its caches,
  // and (b) stop new registrations. Claude works fine without one — a service worker here
  // is only offline/caching sugar, and caching a lease-gated proxied app is never correct.
  // This runs from the <head>-injected overlay, before the app's own scripts register.
  // Gated to Claude (CFG.tool) so no other tool's behaviour changes.
  if (CFG.tool === 'claude' && typeof navigator !== 'undefined' && navigator.serviceWorker) {
    try {
      navigator.serviceWorker.getRegistrations && navigator.serviceWorker.getRegistrations()
        .then(function (regs) { for (var i = 0; i < regs.length; i++) { try { regs[i].unregister(); } catch (e) {} } })
        .catch(function () {});
      if (window.caches && caches.keys) {
        caches.keys().then(function (keys) { for (var i = 0; i < keys.length; i++) { try { caches.delete(keys[i]); } catch (e) {} } }).catch(function () {});
      }
      // Block future registrations (resolve with a harmless rejection the app can handle).
      var _reg = navigator.serviceWorker.register;
      navigator.serviceWorker.register = function () {
        return Promise.reject(new Error('service worker disabled by gateway'));
      };
      void _reg;
    } catch (e) {}
  }

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
    friendlyShown: false,
    degraded: false,       // a retryable failure is currently being shown
    failures: 0,           // consecutive retryable failures (drives backoff)
    lastGoodAt: 0,
    inFlight: false,       // guards against overlapping validations corrupting state
    retryTimer: null,
    lastResumeAt: 0,       // throttles the mobile resume re-check (see resumeCheck below)
    blockedModelNotified: false  // one-shot: the "Fable 5 is disabled" notice per page
  };
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
        '<div class="genz-sw-row genz-sw-acct" id="genz-sw-acct-row" style="display:none"><span>Account</span><b id="genz-sw-acct"></b></div>' +
        '<div class="genz-sw-row genz-sw-cd"><span>Session</span><b id="genz-sw-time">--:--</b></div>' +
        // Claude-only compact "Estimated usage" block — thin progress lines for the five-hour and
        // weekly windows. Hidden until the first /__genz/usage fetch fills it (or when off).
        (CLAUDE ? (
          '<div class="genz-usage" id="genz-usage" style="display:none">' +
            '<div class="genz-usage-lbl">Estimated usage</div>' +
            usageBlockHTML('five', '5-hour usage') +
            usageBlockHTML('week', 'Weekly usage') +
          '</div>'
        ) : '') +
        '<div class="genz-sw-msg" id="genz-sw-msg"></div>' +
        '<a class="genz-sw-support" href="' + SUPPORT_URL + '" target="_blank" rel="noopener" title="Contact support">Contact support</a>' +
      '</div>';
    document.documentElement.appendChild(w);
    el.widget = w; el.time = w.querySelector('#genz-sw-time'); el.msg = w.querySelector('#genz-sw-msg');
    el.min = w.querySelector('.genz-sw-min'); el.head = w.querySelector('.genz-sw-head');
    if (CLAUDE) {
      el.usage = w.querySelector('#genz-usage');
      el.usageFive = w.querySelector('.genz-usage-block[data-w="five"]');
      el.usageWeek = w.querySelector('.genz-usage-block[data-w="week"]');
    }
    w.querySelector('.genz-sw-sub').textContent = TOOL_NAME; // textContent → no HTML injection
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
  function showMessage(text, terminal) { if (!el.msg) return; el.msg.textContent = text; el.msg.style.display = text ? 'block' : 'none'; if (terminal) { state.terminal = true; if (state.collapsed) toggleCollapse(); } render(); }
  function clearMessage() { if (el.msg) { el.msg.textContent = ''; el.msg.style.display = 'none'; } }
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
    return fetch(API + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + (LEASE || '') }, body: JSON.stringify(payload || {}) })
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

  // A terminal screen is a CACHE of one past server verdict, not a fact about now. When an
  // authorized dashboard launch installs a FRESH lease, the server starts answering `valid`
  // again — at which point this document's dead state must be thrown away wholesale.
  // Access is never granted here: we only mirror a server `valid:true`, so a refresh, a
  // restored tab or a replayed page can never renew anything on its own.
  function adoptRenewedSession() {
    log('session_renewed', { was_terminal: true });
    state.terminal = false;
    state.friendlyShown = false;
    state.degraded = false;
    state.failures = 0;
    state.expiresAtMs = 0;          // dropped: the NEW server expiry below is the only truth
    state.secondsRemaining = 0;
    state.skewMs = 0;
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    clearMessage();
  }

  // `resume` bypasses ONLY the terminal early-return, so a re-check can still reach the
  // server after the widget has given up. Everything else is identical.
  function validate(resume) {
    if (state.terminal && !resume) return Promise.resolve();
    if (state.inFlight) return Promise.resolve();   // concurrent calls must not corrupt state
    state.inFlight = true;
    // Claude holds only the OPAQUE HttpOnly session cookie (it cannot read the lease JWT), so it
    // validates via the gateway's own same-origin endpoint (cookie sent automatically) rather than
    // sending a Bearer token to the backend. Every other tool keeps the Bearer flow unchanged.
    var p = (CFG.tool === 'claude')
      ? fetch('/__genz/validate', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); })
      : apiCall('/validate', {});
    return p.then(function (r) {
      state.inFlight = false;
      if (r.status === 200 && r.body && r.body.valid) {
        if (state.terminal) adoptRenewedSession();   // a new authorized lease replaced the dead one
        adoptExpiry(r.body);
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

  // ════════════════════════════════════════════════════════════════════════════
  // EXTRA UI cleanup (backup to the server-side shield): hide account / plan /
  // pricing / billing / subscription / API-keys / logout and brand the identity.
  // ════════════════════════════════════════════════════════════════════════════
  var HIDE_RE = /^(account|my account|account settings|account details|profile|my profile|settings|preferences|log\s?out|sign\s?out|logout|plans?\s*&?\s*pricing|pricing|faq|faqs|help|help center|support|contact us|discord|community|affiliate|affiliate program|refer|refer a friend|invite friends?|earn|rewards|subscription|manage subscription|billing|manage plan|upgrade|upgrade plan|api keys?|api key|developer|get more|starter plan|free plan|basic plan|pro plan|premium( plan)?|enterprise)$/i;
  // Claude-only account-menu items to hide from the client view (beyond the shared HIDE_RE):
  // Language, Apps, Gift Claude, Learn More, Get help, etc. Applied ONLY when CFG.tool==='claude'.
  //
  // CAREFUL with `download`: the target here is the account menu's app-download promos
  // ("Download apps", "Download for Mac"), so the suffix is REQUIRED — `download( apps?| for .+)`
  // and NOT `(...)?`. With the group optional, a bare "Download" matched, and since a text hit
  // hides nearestControl() (up to 4 ancestors), it removed the file card's own Download control
  // and menu item. That is the file-download bug: the request path was never blocked, the button
  // was simply hidden. Any label added here must be a menu/promo item, never a working-area verb.
  var CLAUDE_HIDE_RE = /^(language|apps?|apps? ?(and|&) ?extensions|extensions|integrations|get the app|gift claude|gift|refer|learn more|get help|help( ?(and|&) ?support| ?(and|&) ?feedback| center)?|what'?s new|news|download( apps?| for .+)|desktop app|mobile app|ios app|android app|keyboard shortcuts|shortcuts|role|feedback|send feedback|status|changelog|release notes|privacy( policy)?|terms( of service)?|usage policy|acceptable use|cookie preferences|manage cookies|switch account|add account|log ?in to another( account)?|sign ?in to another( account)?)$/i;
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
  var CLAUDE = (CFG.tool === 'claude');
  // Model allowlist (claude-only). Mirrors lib/modelPolicy.js. UI layer ONLY — the gateway
  // enforces the block server-side, so nothing here is a security control; if this code fails
  // to run, the model is still blocked upstream. Default is blocked: the flag must be
  // explicitly true to allow, so a missing/garbled CFG never silently re-enables Fable 5.
  var ALLOW_FABLE5 = (CFG.allowFable5 === true);
  var BLOCKED_MODEL_RE = /fable/i;
  var BLOCKED_MODEL_MSG = CFG.blockedModelMsg || 'Fable 5 is disabled by your administrator.';
  // ChatGPT and Claude both expose the real account bottom-left; HIDE it (our own switcher/card
  // replaces it) rather than branding it in place. Every other tool keeps the in-place branding.
  function brandOrHide(n) { if (CHATGPT) hide(n); else brandifyControl(n); }
  function isIdentityControl(n) {
    if (!n || hasEditor(n)) return false;
    // Claude keeps its NATIVE account control (we only relabel the avatar + hide name/email leaves);
    // it must never be hidden or branded-away, so it is never treated as an identity control.
    if (CLAUDE) return false;
    if (n.querySelector && n.querySelector('[class*="avatar" i],[class*="initial" i],[class*="userpic" i],[data-avatar]')) return true;
    var a = ((n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('data-testid') || '')) || '').toLowerCase();
    if (/(^|[\s_-])(user[\s_-]?menu|usermenu|avatar)([\s_-]|$)/.test(a)) return true;
    if (n.getAttribute && n.getAttribute('aria-haspopup') && /(^|[\s_-])(account|profile|my[\s_-]?account)([\s_-]|$)/.test(a)) return true;
    // ChatGPT: a bottom-left button/link carrying an avatar/initials is the account switcher.
    if (CHATGPT && n.querySelector && n.querySelector('img,svg,[class*="avatar" i],[class*="initial" i]')) {
      try { var r = n.getBoundingClientRect(); if (r.width && r.left < 380 && r.top > window.innerHeight * 0.55) return true; } catch (e) {}
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

  // ════════════════════════════════════════════════════════════════════════════
  // Claude (claude.ai) — use the NATIVE account button + dropdown, filtered.
  //
  // No custom switcher and no hiding of claude.ai's real bottom-left account control. Instead:
  //  (1) relabelClaudeAccount() relabels ONLY the local avatar initials to "GEN Z" and hides the
  //      account name/email shown on the button — the button stays fully clickable so the native
  //      dropdown still opens;
  //  (2) when the native dropdown opens, the existing text sweep (EMAIL_RE / HIDE_RE /
  //      CLAUDE_HIDE_RE) hides Settings, Language, Help, Upgrade plan, Apps & extensions, Gift
  //      Claude, Learn more, Log out, email and billing, while the Team + Personal WORKSPACE rows
  //      (matched by WS_KEEP_RE) are protected and kept.
  // Clicking a workspace runs claude.ai's OWN switch handler — we never simulate it. Persistence
  // through the proxy is handled SERVER-SIDE: the gateway forwards the browser's native
  // `lastActiveOrg` upstream, so selecting Personal genuinely loads the Personal workspace and
  // clears any stale "Team plan canceled" state. No account name/email/org id/cookie/token exposed.

  // Text of a WORKSPACE / ORG row that must stay visible in the native dropdown (never hidden).
  var WS_KEEP_RE = /(workspace|personal|team|organization|organisation|switch to|business|enterprise plan)/i;

  // ── Workspace switch in the always-visible widget (RELIABLE version) ─────────────────────────
  // Uses claude's OWN `lastActiveOrg` cookie: the overlay sets it in the browser and the gateway
  // forwards it upstream, so claude.ai serves that workspace. The choice lives in the BROWSER (not
  // per-worker server memory), so it works on every request/worker — this is the version that
  // actually switched to Personal. Reads the real workspaces from claude's /api/organizations;
  // no id is shown to the user.
  function currentWs() { return getCookie('lastActiveOrg'); }
  function switchWs(uuid) {
    if (!uuid) return;
    try { document.cookie = 'lastActiveOrg=' + uuid + '; Path=/; Max-Age=31536000; SameSite=Lax'; } catch (e) {}
    toast('Switching workspace…');
    setTimeout(function () { location.reload(); }, 250);
  }
  function buildClaudeWorkspaces() {
    if (!CLAUDE || !el.widget) return;
    fetch('/api/organizations', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) return;
        var personal = null, team = null;
        for (var i = 0; i < list.length; i++) { var o = list[i]; if (!o || !o.uuid) continue; var nm = String(o.name || ''); if (/@|'s organization|personal/i.test(nm)) { if (!personal) personal = o; } else if (!team) team = o; }
        if (!personal) personal = list[list.length - 1];
        if (personal === team) team = null;
        var body = el.widget.querySelector('.genz-sw-body'); if (!body) return;
        var wrap = el.widget.querySelector('#genz-ws-row');
        if (!wrap) { wrap = document.createElement('div'); wrap.id = 'genz-ws-row'; var cd = body.querySelector('.genz-sw-cd'); if (cd && cd.nextSibling) body.insertBefore(wrap, cd.nextSibling); else body.appendChild(wrap); }
        var cur = currentWs();
        function mk(label, o) {
          if (!o || !o.uuid) return '';
          var on = cur && cur === o.uuid;
          return '<button class="genz-ws-btn' + (on ? ' on' : '') + '" data-uuid="' + o.uuid + '"' + (on ? ' disabled' : '') + '>' + label + (on ? ' ✓' : '') + '</button>';
        }
        wrap.innerHTML = '<div class="genz-ws-lbl">Workspace</div><div class="genz-ws-btns">' + mk('Personal', personal) + mk('Team', team) + '</div>';
        var bs = wrap.querySelectorAll('.genz-ws-btn');
        for (var j = 0; j < bs.length; j++) { (function (bb) { bb.addEventListener('click', function () { if (!bb.disabled) switchWs(bb.getAttribute('data-uuid')); }); })(bs[j]); }
      }).catch(function () {});
  }

  // Relabel ONLY the local avatar to "GEN Z" and hide the account name/email on the native
  // bottom-left button, keeping the button (and thus the native dropdown) fully functional.
  function relabelClaudeAccount() {
    if (!CLAUDE) return;
    try {
      var btns = document.querySelectorAll('button,[role="button"],a');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.closest && b.closest('#genz-sw-widget')) continue;
        // Only the account TRIGGER button — never the dropdown's workspace/menu rows (they stay
        // native so the original Team + Personal options are preserved).
        if (b.getAttribute && b.getAttribute('role') === 'menuitem') continue;
        if (b.closest && b.closest('[role="menu"],[role="listbox"],[role="dialog"],[data-radix-menu-content]')) continue;
        var rr; try { rr = b.getBoundingClientRect(); } catch (e) { continue; }
        if (!(rr.width && rr.left < 380 && rr.top > window.innerHeight * 0.5)) continue;   // bottom-left only
        // Locate the avatar: a class-based avatar, else a 1–3 letter initials leaf.
        var ava = b.querySelector('[class*="avatar" i],[class*="initial" i],[class*="userpic" i]');
        if (!ava) {
          var els = b.querySelectorAll('span,div');
          for (var j = 0; j < els.length; j++) { var tt = ownText(els[j]); if (tt && /^[A-Za-z]{1,3}$/.test(tt) && !(els[j].querySelector && els[j].querySelector('*'))) { ava = els[j]; break; } }
        }
        if (!ava) continue;
        b.setAttribute('data-genz-acct', '1');
        // avatar → GEN Z (protected from the sweep so it is never re-hidden)
        if (ava.getAttribute('data-genz-brand') !== '1') {
          ava.textContent = 'GEN Z'; ava.setAttribute('data-genz-brand', '1');
          ava.style.setProperty('font-size', '8px', 'important'); ava.style.setProperty('letter-spacing', '0', 'important');
          ava.style.setProperty('display', 'flex', 'important'); ava.style.setProperty('align-items', 'center', 'important'); ava.style.setProperty('justify-content', 'center', 'important');
        }
        // Hide the account name / email text on the button (NOT the avatar, NOT a workspace label).
        var leaves = b.querySelectorAll('span,div,p,b,strong');
        for (var k = 0; k < leaves.length; k++) {
          var lf = leaves[k];
          if (lf === ava || (ava.contains && ava.contains(lf)) || (lf.contains && lf.contains(ava))) continue;
          if (hasEditor(lf)) continue;
          var tx = ownText(lf);
          if (tx && (EMAIL_RE.test(tx) || (tx.length > 1 && !WS_KEEP_RE.test(tx)))) lf.style.setProperty('display', 'none', 'important');
        }
      }
    } catch (e) {}
  }

  // Keep claude.ai's NATIVE bottom-left account/profile button PERMANENTLY visible. When there are
  // many recent chats the list can grow past the viewport and push the account footer below the
  // scroll. Fix the sidebar into a proper flex column: sidebar = 100dvh flex column; the recent-
  // chats/history area = flex:1 with its OWN vertical scroll (min-height:0 so it can shrink,
  // overflow-x hidden so no horizontal scrollbar); the account footer = flex-shrink:0, sticky to
  // the bottom, above the list. DOM-independent: we locate everything from the (already-found)
  // account button rather than guessing claude's obfuscated class names. Re-applied each sweep so
  // SPA re-renders can't undo it. Never covers the chats (the list scrolls; the footer sits below).
  function pinClaudeAccount() {
    if (!CLAUDE) return;
    try {
      var btn = document.querySelector('[data-genz-acct="1"]');
      if (!btn) return;
      // Walk up from the button: `footer` = its top-level block inside the sidebar; `sidebar` = the
      // tall, narrow, left-anchored container (a real sidebar, not the whole app shell).
      var node = btn, footer = btn, sidebar = null;
      for (var i = 0; i < 10 && node && node !== document.body; i++) {
        var r; try { r = node.getBoundingClientRect(); } catch (e) { break; }
        if (r.height >= window.innerHeight * 0.6 && r.left < 90 && r.width >= 150 && r.width <= 520) { sidebar = node; break; }
        footer = node; node = node.parentElement;
      }
      if (!sidebar || sidebar === document.body || sidebar === document.documentElement) return;
      if (sidebar.getAttribute('data-genz-sb') !== '1') {
        sidebar.setAttribute('data-genz-sb', '1');
        sidebar.style.setProperty('height', '100dvh', 'important');
        sidebar.style.setProperty('max-height', '100dvh', 'important');
        sidebar.style.setProperty('display', 'flex', 'important');
        sidebar.style.setProperty('flex-direction', 'column', 'important');
        sidebar.style.setProperty('overflow', 'hidden', 'important');   // inner areas scroll, not the sidebar
      }
      // Account footer → never shrinks, sticks to the bottom, sits above the list.
      footer.setAttribute('data-genz-ftr', '1');
      footer.style.setProperty('flex', '0 0 auto', 'important');
      footer.style.setProperty('position', 'sticky', 'important');
      footer.style.setProperty('bottom', '0', 'important');
      footer.style.setProperty('z-index', '30', 'important');
      try { var bg = getComputedStyle(sidebar).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') footer.style.setProperty('background', bg, 'important'); } catch (e) {}
      // The recent-chats / history area (the child that overflows or holds the chat list) → flex:1
      // with its own scroll; every other top area (logo / new chat) stays natural height.
      var kids = sidebar.children;
      for (var j = 0; j < kids.length; j++) {
        var k = kids[j];
        if (k === footer || (k.contains && k.contains(footer))) continue;
        var isList = false;
        try { isList = (k.scrollHeight > k.clientHeight + 8) || !!(k.querySelector && k.querySelector('a[href*="/chat"],a[href*="/recent"],a[href*="/project"],nav,ul,ol,[data-testid*="history" i],[class*="history" i]')); } catch (e) {}
        if (isList) {
          k.style.setProperty('flex', '1 1 auto', 'important');
          k.style.setProperty('min-height', '0', 'important');
          k.style.setProperty('overflow-y', 'auto', 'important');
          k.style.setProperty('overflow-x', 'hidden', 'important');
        } else {
          k.style.setProperty('flex', '0 0 auto', 'important');
        }
      }
    } catch (e) {}
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
  // Per-node rules (identical to before). PERF: the observer below sweeps only ADDED subtrees,
  // so cost scales with new content instead of re-scanning the whole DOM on every mutation —
  // essential on streaming SPAs (ChatGPT/Grok) where the DOM changes constantly.
  var SWEEP_SEL = 'a,button,[role="button"],li,span,div,p,h1,h2,h3,h4';
  function processOne(n) {
    if (!n || n.nodeType !== 1) return;
    if (n.__genz || n.id === 'genz-sw-widget' || (n.closest && n.closest('#genz-sw-widget'))) return;
    if (isCaptchaNode(n)) return;   // NEVER hide/brand a captcha/challenge widget
    n.__genz = true;
    var ctag = (n.tagName || '').toLowerCase();
    if ((ctag === 'button' || ctag === 'a' || (n.getAttribute && n.getAttribute('role') === 'button')) && isIdentityControl(n)) { brandOrHide(n); return; }
    var t = ownText(n);
    if (!t || t.length > 60) return;
    if (KEEP_RE.test(t)) return;
    // Claude: NEVER hide a workspace / organization row — these are the Team + Personal options the
    // client must keep in the native dropdown (the sweep hides all the OTHER items by text below).
    if (CLAUDE && WS_KEEP_RE.test(t)) return;
    if (hasEditor(n)) return;
    if (FORBIDDEN_RE.test(t)) { showFriendlyError(); hide(nearestControl(n)); return; }
    // Claude: hide the email at the LEAF so the native account button/dropdown stays intact
    // (hiding nearestControl could remove the whole clickable button).
    if (EMAIL_RE.test(t)) { if (CLAUDE) hide(n); else brandOrHide(nearestControl(n)); return; }
    // Model allowlist, UI layer only. The real block is server-side (the gateway rewrites the
    // model on the way upstream), so this is purely so the client does not see and click an
    // option that would be silently switched anyway. Scoped to a menu-item-sized label that
    // names the blocked model, so ordinary prose mentioning it in a message is never touched,
    // and no other model is affected. Skips the composer/editor for the same reason.
    if (CLAUDE && !ALLOW_FABLE5 && BLOCKED_MODEL_RE.test(t) && t.length <= 40 && !hasEditor(n)) {
      var ctrl = nearestControl(n);
      if (ctrl && !ctrl.__genzBlockedModel) {
        ctrl.__genzBlockedModel = 1;
        hide(ctrl);
        // Explain it the first time the client opens the picker looking for it, rather than
        // letting the option vanish with no reason given. Once per page, never repeated, and
        // it uses the existing toast so no new UI surface is introduced.
        if (!state.blockedModelNotified) {
          state.blockedModelNotified = true;
          try { toast(BLOCKED_MODEL_MSG); } catch (e) {}
        }
        log('model_option_hidden', {});
      }
      return;
    }
    if (CLAUDE && CLAUDE_HIDE_RE.test(t)) { hide(nearestControl(n)); return; }
    if (HIDE_RE.test(t)) { hide(nearestControl(n)); return; }
    if (USAGE_RE.test(t)) { hide(n); }
  }
  function sweep(root) {
    var base = (root && root.nodeType === 1) ? root : (document.body || document.documentElement);
    if (!base) return;
    try {
      if (base.matches && base.matches(SWEEP_SEL)) processOne(base); // the subtree root itself
      var nodes = base.querySelectorAll(SWEEP_SEL);
      for (var i = 0; i < nodes.length; i++) processOne(nodes[i]);
    } catch (e) {}
  }
  function injectHideStyle() {
    var hrefs = ['pricing', 'billing', 'account', 'affiliate', 'discord', '/faq', 'support', 'subscription',
      'upgrade', 'refer', 'plans', '/settings', '/profile', '/me', 'api-key', 'apikey',
      'logout', 'log-out', 'sign-out', 'signout'];
    var parts = hrefs.map(function (h) { return 'a[href*="' + h + '"]:not([data-genz-brand])'; });
    // Operator-supplied per-tool exact selectors (e.g. an obfuscated account container).
    for (var i = 0; i < HIDE_SELECTORS.length; i++) { if (HIDE_SELECTORS[i]) parts.push(HIDE_SELECTORS[i]); }
    var css = parts.join(',') + ',[data-genz-hidden="1"]{display:none !important;}';
    var s = document.createElement('style'); s.id = 'genz-sw-hide'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  function runHiding() { try { sweep(document); enforceBranding(); checkCaptcha(); hideChatgptAccount(); relabelClaudeAccount(); pinClaudeAccount(); } catch (e) {} }

  // PERF: process only added subtrees on mutations (debounced); reserve the full pass for first
  // paint, SPA route change and a low-frequency safety tick. The maintenance helpers
  // (branding/captcha/chatgpt-account) run once per debounced flush instead of once per mutation.
  var pending = [];
  var flushTimer = null;
  var fullPending = false;
  function flush() {
    flushTimer = null;
    try {
      if (fullPending) { fullPending = false; pending.length = 0; sweep(document); }
      else { var b = pending; pending = []; for (var i = 0; i < b.length; i++) sweep(b[i]); }
      enforceBranding(); checkCaptcha(); hideChatgptAccount(); relabelClaudeAccount(); pinClaudeAccount();
    } catch (e) {}
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

  // ── Claude "Estimated usage" widget lines (five-hour + weekly) ───────────────
  // Compact, Claude-style: "62% used", a thin progress line, "12.4k / 20k · Resets …", and a
  // discreet Custom/Default tag. All values come from the gateway (server-side estimate); the
  // widget NEVER invents a number — a missing figure renders as "Not synced".
  function usageBlockHTML(key, name) {
    return '<div class="genz-usage-block" data-w="' + key + '">' +
        '<div class="genz-usage-top">' +
          '<span class="genz-usage-name">' + name + '<span class="genz-usage-tag"></span></span>' +
          '<span class="genz-usage-pct"></span>' +
        '</div>' +
        '<div class="genz-usage-bar"><i></i></div>' +
        '<div class="genz-usage-meta"></div>' +
      '</div>';
  }
  // Compact token formatting: 900 → "900", 12400 → "12.4k", 20000 → "20k", 1_500_000 → "1.5M".
  function fmtTokens(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n < 1000) return String(n);
    if (n < 1000000) { var k = n / 1000; return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + 'k'; }
    var m = n / 1000000; return (m >= 100 ? Math.round(m) : Math.round(m * 10) / 10) + 'M';
  }
  // Exact reset text. Five-hour → "Resets today at 11:00 PM" (today/tomorrow/weekday). Weekly →
  // "Resets Tuesday, 21 July at 5:00 PM PKT" (weekday, date, time, timezone). Uses the viewer's
  // own locale + timezone so every client sees their local reset moment of the shared cycle.
  function fmtReset(ms, weekly) {
    if (ms == null || !isFinite(ms)) return '';
    var d = new Date(ms), now = new Date();
    var timeStr;
    try { timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { timeStr = d.toTimeString().slice(0, 5); }
    if (weekly) {
      var wd = '', dm = '', tz = '';
      try { wd = d.toLocaleDateString([], { weekday: 'long' }); } catch (e) {}
      try { dm = d.toLocaleDateString([], { day: 'numeric', month: 'long' }); } catch (e) {}
      try { var parts = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(d); for (var i = 0; i < parts.length; i++) { if (parts[i].type === 'timeZoneName') { tz = parts[i].value; break; } } } catch (e) {}
      return 'Resets ' + (wd ? wd + ', ' : '') + dm + ' at ' + timeStr + (tz ? ' ' + tz : '');
    }
    var sameDay = d.toDateString() === now.toDateString();
    var tmr = new Date(now.getTime()); tmr.setDate(now.getDate() + 1);
    var isTmr = d.toDateString() === tmr.toDateString();
    var day = sameDay ? 'today' : (isTmr ? 'tomorrow' : (function () { try { return d.toLocaleDateString([], { weekday: 'long' }); } catch (e) { return 'soon'; } })());
    return 'Resets ' + day + ' at ' + timeStr;
  }
  function renderUsageBlock(block, w, weekly) {
    if (!block) return;
    var pctEl = block.querySelector('.genz-usage-pct');
    var barEl = block.querySelector('.genz-usage-bar > i');
    var metaEl = block.querySelector('.genz-usage-meta');
    var tagEl = block.querySelector('.genz-usage-tag');
    // No data for this window → "Not synced" (never a fabricated 0).
    if (!w || w.limit == null) {
      if (pctEl) pctEl.textContent = '';
      if (barEl) barEl.style.width = '0%';
      if (metaEl) metaEl.textContent = 'Not synced';
      if (tagEl) tagEl.textContent = '';
      block.classList.remove('genz-usage-full', 'genz-usage-warn');
      return;
    }
    var pct = Math.max(0, Math.min(100, Math.round(Number(w.percent) || 0))); // capped at 100%
    // Bar is ALWAYS capped at 100%; the label reads "Limit exceeded" when usage is over the limit.
    if (pctEl) pctEl.textContent = w.over ? 'Limit exceeded' : (pct + '% used');
    if (barEl) barEl.style.width = pct + '%';
    block.classList.toggle('genz-usage-full', !!w.atLimit);           // at/over limit → blocked
    block.classList.toggle('genz-usage-warn', pct >= 80 && !w.atLimit);
    // Usage (used / limit) ALWAYS shows. The reset text shows the exact moment only when the
    // account carries an OFFICIAL reset timestamp for this window; otherwise "Reset not synced"
    // (never a fabricated time). This keeps the widget identical to the admin table.
    var meta = fmtTokens(w.used) + ' / ' + fmtTokens(w.limit);
    var reset = w.resetOfficial ? fmtReset(w.resetAt, weekly) : '';
    if (metaEl) metaEl.textContent = meta + ' · ' + (reset || 'Reset not synced');
    if (tagEl) { tagEl.textContent = w.source === 'custom' ? 'Custom' : 'Default'; tagEl.classList.toggle('custom', w.source === 'custom'); }
  }
  function fetchUsage() {
    if (!CLAUDE || !el.usage) return;
    fetch('/__genz/usage', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (!j || j.enabled === false) { el.usage.style.display = 'none'; applyQuotaBlock(false); return; } // feature off → hide + unblock
        el.usage.style.display = '';
        var st = j.status || {};
        var synced = j.synced !== false && st.synced !== false;
        if (!synced) { renderUsageBlock(el.usageFive, null, false); renderUsageBlock(el.usageWeek, null, true); applyQuotaBlock(false); return; }
        renderUsageBlock(el.usageFive, st.fiveHour, false);
        renderUsageBlock(el.usageWeek, st.weekly, true);
        // Strict enforcement is server-side (the gateway returns 429 and never calls Claude). This
        // only mirrors that state in the UI: when either window has no room left, disable the local
        // composer/search/upload controls and show when access returns. Never the source of truth.
        var five = st.fiveHour || {}, week = st.weekly || {};
        var blocked = !!(five.atLimit || week.atLimit);
        var info = five.atLimit ? five : (week.atLimit ? week : null);
        applyQuotaBlock(blocked, info, week.atLimit && !five.atLimit);
      })
      .catch(function () { /* transient — keep last-known values on screen */ });
  }

  // Mirror the server-side block in the page: toggle a root class that disables the composer,
  // send, search and file-upload controls (via overlay.css), and show a banner with the exact
  // reset time. A capture-phase key/click guard stops an in-flight submit; the backend 429 is the
  // real guarantee, so even if a control slips through, Claude is never called.
  function applyQuotaBlock(blocked, info, weekly) {
    try {
      var root = document.documentElement;
      root.classList.toggle('genz-quota-blocked', !!blocked);
      var banner = document.getElementById('genz-quota-banner');
      if (!blocked) { if (banner) banner.style.display = 'none'; return; }
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'genz-quota-banner';
        banner.innerHTML = '<span class="genz-qb-dot"></span><span class="genz-qb-text"></span>';
        document.documentElement.appendChild(banner);
      }
      var when = (info && info.resetOfficial && info.resetAt) ? fmtReset(info.resetAt, !!weekly) : '';
      var scope = weekly ? 'Weekly' : '5-hour';
      banner.querySelector('.genz-qb-text').textContent =
        'Usage limit reached (' + scope + '). New messages are paused' + (when ? ' — ' + when.replace(/^Resets/, 'resets') : ' until the limit resets') + '.';
      banner.style.display = '';
    } catch (e) { /* UI mirror only */ }
  }
  // Capture-phase guard: while blocked, swallow Enter-to-send and clicks on send/upload controls in
  // the composer so nothing is dispatched. Backend enforcement still applies regardless.
  function isBlocked() { return document.documentElement.classList.contains('genz-quota-blocked'); }
  document.addEventListener('keydown', function (e) {
    if (!CLAUDE || !isBlocked()) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      var t = e.target;
      if (t && (t.isContentEditable || (t.tagName && t.tagName.toLowerCase() === 'textarea'))) { e.preventDefault(); e.stopPropagation(); toast('Usage limit reached — new messages are paused until reset.'); }
    }
  }, true);
  document.addEventListener('click', function (e) {
    if (!CLAUDE || !isBlocked()) return;
    var b = e.target && e.target.closest && e.target.closest('button,[role="button"],input[type="file"]');
    if (!b || (b.closest && b.closest('#genz-sw-widget,#genz-quota-banner'))) return;
    var al = ((b.getAttribute && (b.getAttribute('aria-label') || '')) + ' ' + (b.getAttribute && (b.getAttribute('data-testid') || ''))).toLowerCase();
    if (/send|attach|upload|file|search|research|tool/.test(al) || b.type === 'file' || (b.getAttribute && b.getAttribute('type') === 'submit')) {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  // ── Claude default-effort auto-select (claude-only) ──────────────────────────
  // Mirrors lib/effortPrefs.js (the unit-tested reference). Best-effort DOM automation: on a fresh
  // session / new conversation, once the composer is ready, detect the current effort and — only
  // if it differs from the configured default — open the menu, pick the default, close. Applied
  // ONCE per conversation; never overrides a later manual change; warns (console) and continues if
  // the control is unavailable or Claude changed its UI. Never touches the model or the workspace.
  var EFF_LEVELS = ['low', 'medium', 'high', 'extra', 'max'];
  var EFF_ALIAS = { low: 'low', lo: 'low', light: 'low', medium: 'medium', med: 'medium', mid: 'medium', standard: 'medium', normal: 'medium', balanced: 'medium', 'default': 'medium', high: 'high', hi: 'high', extra: 'extra', 'extra high': 'extra', extrahigh: 'extra', 'very high': 'extra', higher: 'extra', max: 'max', maximum: 'max', highest: 'max', ultra: 'max' };
  function effLevel(v) { if (v == null) return null; var s = String(v).trim().toLowerCase(); if (EFF_LEVELS.indexOf(s) >= 0) return s; return EFF_ALIAS[s] || null; }
  function effNorm(v, fb) { return effLevel(v) || (EFF_LEVELS.indexOf(fb) >= 0 ? fb : 'medium'); }
  function effSame(a, b) { var x = effLevel(a), y = effLevel(b); return !!x && !!y && x === y; }
  function effParse(text) { if (text == null) return null; var s = String(text).toLowerCase(); var o = ['extra high', 'very high', 'extrahigh', 'maximum', 'highest', 'ultra', 'extra', 'max', 'higher', 'high', 'medium', 'standard', 'normal', 'balanced', 'low']; for (var i = 0; i < o.length; i++) { var re = new RegExp('(^|[^a-z])' + o[i].replace(/ /g, '\\s+') + '([^a-z]|$)', 'i'); if (re.test(s)) { var l = effLevel(o[i]); if (l) return l; } } return null; }
  function effConvKey(p) { p = String(p || '').replace(/[#?].*$/, '').replace(/\/+$/, '') || '/'; var m; if ((m = p.match(/\/chat\/([\w-]+)/i))) return 'chat:' + m[1]; if ((m = p.match(/\/project\/([\w-]+)/i))) return 'project:' + m[1]; if (/\/new$/i.test(p) || p === '/' || p === '') return 'new'; return 'path:' + p; }
  function effNextConv(prev, p) { var key = effConvKey(p); if (prev == null) return { key: key, fresh: true, inherit: false }; if (key === prev) return { key: key, fresh: false, inherit: false }; if (prev === 'new' && key.indexOf('chat:') === 0) return { key: key, fresh: false, inherit: true }; if (key === 'new') return { key: key, fresh: true, inherit: false }; return { key: key, fresh: false, inherit: false }; }

  var EFFORT_TARGET = effNorm(CFG.defaultEffort, 'medium');
  var THINKING_DEFAULT = CFG.thinkingDefault === true;
  var EFFORT_SEL = CFG.effortTriggerSel || '';
  var effSt = { convKey: null, handledFor: null, thinkHandledFor: null, attempts: 0, warned: false };
  var EFF_MAX_ATTEMPTS = 30; // ~30 × 1s ≈ 24s for the composer to render before we give up

  function effWarn(msg) { if (effSt.warned) return; effSt.warned = true; try { console.warn('[Gen Z] Claude effort auto-select: ' + msg + ' — continuing normally.'); } catch (e) {} }
  function composerReady() { try { return !!document.querySelector('main [contenteditable="true"], main textarea, [data-testid="chat-input"], form [contenteditable="true"], form textarea, div[contenteditable="true"][role="textbox"]'); } catch (e) { return false; } }

  function findEffortTrigger() {
    try {
      var cands = [];
      if (EFFORT_SEL) { try { cands = Array.prototype.slice.call(document.querySelectorAll(EFFORT_SEL)); } catch (e) {} }
      if (!cands.length) cands = Array.prototype.slice.call(document.querySelectorAll('button,[role="button"]'));
      for (var i = 0; i < cands.length; i++) {
        var b = cands[i]; if (!b || (b.closest && b.closest('#genz-sw-widget,#genz-quota-banner,#genz-ws-row'))) continue;
        var al = ((b.getAttribute && (b.getAttribute('aria-label') || '')) + ' ' + (b.textContent || '')).toLowerCase();
        var lvl = effParse(al);
        // Only accept a pinned selector match, or a control that clearly names effort/thinking-effort
        // (so we never mis-click an unrelated "medium"/"high" button in the page).
        if (EFFORT_SEL) return { el: b, current: lvl };
        if (/effort/.test(al) && lvl != null) return { el: b, current: lvl };
      }
    } catch (e) {}
    return null;
  }
  function applyEffort(trigger, target) {
    try {
      trigger.click(); // open the menu (async render)
      setTimeout(function () {
        try {
          // Scope selection to the menu the trigger opened — NEVER a page-wide search (which could
          // click a stray element elsewhere in the page that happens to contain an effort word).
          var menu = document.querySelector('[role="menu"],[role="listbox"],[data-radix-menu-content]');
          if (!menu) { effWarn('effort menu did not open (UI changed) — leaving effort unchanged'); return; }
          var items = menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],button,li');
          var picked = null;
          for (var i = 0; i < items.length; i++) { var t = ((items[i].getAttribute && (items[i].getAttribute('aria-label') || '')) + ' ' + (items[i].textContent || '')); if (effSame(effParse(t), target)) { picked = items[i]; break; } }
          if (picked) picked.click();
          else { effWarn('effort option "' + target + '" not found in menu'); try { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {} }
        } catch (e) { effWarn('could not select the effort option'); }
      }, 200);
      return true;
    } catch (e) { effWarn('could not open the effort menu'); return false; }
  }

  function findThinkingToggle() {
    try {
      var cands = Array.prototype.slice.call(document.querySelectorAll('button,[role="switch"],[role="checkbox"],[role="menuitemcheckbox"]'));
      for (var i = 0; i < cands.length; i++) {
        var b = cands[i]; if (!b || (b.closest && b.closest('#genz-sw-widget,#genz-quota-banner'))) continue;
        var al = ((b.getAttribute && (b.getAttribute('aria-label') || '')) + ' ' + (b.textContent || '')).toLowerCase();
        if (/extended thinking|think longer|thinking mode|^\s*thinking\s*$/.test(al)) {
          var pr = b.getAttribute && (b.getAttribute('aria-pressed') || b.getAttribute('aria-checked'));
          return { el: b, on: pr === 'true' ? true : (pr === 'false' ? false : null) };
        }
      }
    } catch (e) {}
    return null;
  }

  function effortTick() {
    if (!CLAUDE) return;
    // Track the conversation; reset (or carry) the handled flags on a change.
    var st = effNextConv(effSt.convKey, location.pathname);
    if (st.key !== effSt.convKey) {
      effSt.convKey = st.key;
      if (st.fresh) { effSt.handledFor = null; effSt.thinkHandledFor = null; effSt.attempts = 0; effSt.warned = false; }
      else if (st.inherit) { effSt.handledFor = effSt.convKey; effSt.thinkHandledFor = effSt.convKey; } // /new→/chat: carry, no re-apply
    }
    // Count an attempt once per tick while EITHER effort or thinking is still pending, so both
    // share the same bounded retry budget (a fresh conversation resets it above).
    var effortPending = effSt.handledFor !== effSt.convKey;
    var thinkPending = THINKING_DEFAULT && effSt.thinkHandledFor !== effSt.convKey;
    if (effortPending || thinkPending) effSt.attempts++;
    var exhausted = effSt.attempts >= EFF_MAX_ATTEMPTS;
    // ── Effort ──
    if (effortPending) {
      var ready = composerReady();
      var trig = ready ? findEffortTrigger() : null;
      if (!ready) { /* wait */ }
      else if (!trig || trig.current == null) { if (exhausted) { effSt.handledFor = effSt.convKey; effWarn('effort control unavailable / UI changed'); } /* else wait */ }
      else if (effSame(trig.current, EFFORT_TARGET)) { effSt.handledFor = effSt.convKey; } // already selected → don't click
      else { effSt.handledFor = effSt.convKey; applyEffort(trig.el, EFFORT_TARGET); } // apply once
    }
    // ── Thinking default (separate; only when admin-enabled) ──
    if (thinkPending) {
      var ready2 = composerReady();
      var tog = ready2 ? findThinkingToggle() : null;
      if (!ready2) { /* wait */ }
      else if (!tog || tog.on == null) { if (exhausted) { effSt.thinkHandledFor = effSt.convKey; effWarn('thinking control unavailable / UI changed'); } }
      else if (tog.on === true) { effSt.thinkHandledFor = effSt.convKey; } // already on
      else { effSt.thinkHandledFor = effSt.convKey; try { tog.el.click(); } catch (e) {} } // enable once
    }
  }

  function start() {
    // Claude uses the opaque HttpOnly __Host-claude_session cookie (unreadable by JS), so there is
    // no pg_lease to read here — proceed and let /__genz/validate confirm the session server-side.
    if (!LEASE && CFG.tool !== 'claude') { buildWidget(); showMessage(MSG.lease_missing, true); return; }
    if (CFG.capture) { buildCaptureUI(); return; }
    buildWidget();
    buildChatgptAccountCard();
    injectHideStyle();
    runHiding();
    if (CLAUDE) {
      buildClaudeWorkspaces(); setTimeout(buildClaudeWorkspaces, 3000);
      fetchUsage(); setInterval(fetchUsage, 30000);
      // Auto-select the default effort on this fresh session, then keep watching for new
      // conversations (each tick is a cheap no-op once the current conversation is handled).
      try { effortTick(); setInterval(effortTick, 1000); } catch (e) {}
    }
    var mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    var _ps = history.pushState; history.pushState = function () { var r = _ps.apply(this, arguments); scheduleFull(); return r; };
    window.addEventListener('popstate', scheduleFull);
    setInterval(scheduleFull, 3000);
    validate();
    setInterval(tick, 1000);
    setInterval(function () { validate(); }, 30000);

    // ── Mobile tab-resume re-check (CLAUDE ONLY) ──────────────────────────────
    // ROOT CAUSE this fixes: on a phone, "reopen the tool from your dashboard" usually
    // resurfaces the EXISTING tab out of bfcache / the frozen-tab store rather than
    // creating a new document. That tab still holds `state.terminal = true` from the
    // session that expired, and both validate() and tick() early-return on terminal — so
    // the expired widget is replayed forever even though a fresh 30-minute lease was
    // issued and its cookie is already installed on this origin. Desktop never hit this
    // because `window.open(url, '_blank')` there really does build a fresh document.
    //
    // Timers do not fire while a mobile tab is frozen, so recovery cannot be left to the
    // 30s poll — it has to be driven by the resume events themselves.
    //
    // SECURITY: this only ever ASKS the server again. Renewal happens exclusively when the
    // server answers `valid:true`, which requires the fresh lease cookie an authorized
    // dashboard launch installed. A refresh, a restored page or a replayed screen with no
    // new lease still gets a terminal verdict and stays denied.
    if (CLAUDE) {
      var resumeCheck = function (why) {
        var now = Date.now();
        if (now - state.lastResumeAt < 3000) return;   // coalesce the burst of resume events
        state.lastResumeAt = now;
        log('resume_check', { reason: why, terminal: !!state.terminal });
        validate(true);
      };
      // bfcache restore (Android Chrome + iOS Safari): `persisted` means this document was
      // frozen whole and is being replayed — exactly the case that must not show stale state.
      window.addEventListener('pageshow', function (e) { resumeCheck(e && e.persisted ? 'bfcache' : 'pageshow'); });
      // Tab switcher / app switcher / screen unlock — no new document, just re-shown.
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') resumeCheck('visible');
      });
      window.addEventListener('focus', function () { resumeCheck('focus'); });
      window.addEventListener('online', function () { resumeCheck('online'); });
    }
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
