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
        '<div class="genz-sw-row genz-sw-acct" id="genz-sw-acct-row" style="display:none"><span>Account</span><b id="genz-sw-acct"></b></div>' +
        '<div class="genz-sw-row genz-sw-cd"><span>Session</span><b id="genz-sw-time">--:--</b></div>' +
        '<div class="genz-sw-msg" id="genz-sw-msg"></div>' +
        '<a class="genz-sw-support" href="' + SUPPORT_URL + '" target="_blank" rel="noopener" title="Contact support">Contact support</a>' +
      '</div>';
    document.documentElement.appendChild(w);
    el.widget = w; el.time = w.querySelector('#genz-sw-time'); el.msg = w.querySelector('#genz-sw-msg');
    el.min = w.querySelector('.genz-sw-min'); el.head = w.querySelector('.genz-sw-head');
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
    // Claude holds only the OPAQUE HttpOnly session cookie (it cannot read the lease JWT), so it
    // validates via the gateway's own same-origin endpoint (cookie sent automatically) rather than
    // sending a Bearer token to the backend. Every other tool keeps the Bearer flow unchanged.
    var p = (CFG.tool === 'claude')
      ? fetch('/__genz/validate', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); })
      : apiCall('/validate', {});
    return p.then(function (r) {
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
  // Claude-only account-menu items to hide from the client view (beyond the shared HIDE_RE):
  // Language, Apps, Gift Claude, Learn More, Get help, etc. Applied ONLY when CFG.tool==='claude'.
  var CLAUDE_HIDE_RE = /^(language|apps?|apps? ?(and|&) ?extensions|extensions|integrations|get the app|gift claude|gift|refer|learn more|get help|help( ?(and|&) ?support| ?(and|&) ?feedback| center)?|what'?s new|news|download( apps?| for .+)?|desktop app|mobile app|ios app|android app|keyboard shortcuts|shortcuts|role|feedback|send feedback|status|changelog|release notes|privacy( policy)?|terms( of service)?|usage policy|acceptable use|cookie preferences|manage cookies|switch account|add account|log ?in to another( account)?|sign ?in to another( account)?)$/i;
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

  function start() {
    // Claude uses the opaque HttpOnly __Host-claude_session cookie (unreadable by JS), so there is
    // no pg_lease to read here — proceed and let /__genz/validate confirm the session server-side.
    if (!LEASE && CFG.tool !== 'claude') { buildWidget(); showMessage(MSG.lease_missing, true); return; }
    if (CFG.capture) { buildCaptureUI(); return; }
    buildWidget();
    buildChatgptAccountCard();
    injectHideStyle();
    runHiding();
    if (CLAUDE) { buildClaudeWorkspaces(); setTimeout(buildClaudeWorkspaces, 3000); }
    var mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    var _ps = history.pushState; history.pushState = function () { var r = _ps.apply(this, arguments); scheduleFull(); return r; };
    window.addEventListener('popstate', scheduleFull);
    setInterval(scheduleFull, 3000);
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
