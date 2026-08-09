/**
 * EXTENSION-BASED Claude model + effort policy — MAIN-world enforcer (claude.ai ONLY).
 * ---------------------------------------------------------------------------------
 * SCOPE — READ THIS BEFORE EDITING.
 *   This file governs the REAL claude.ai opened through the extension. It is registered
 *   for `https://claude.ai/*` and `https://*.claude.ai/*` only, so it can NEVER match the
 *   PROXY Claude host (claude1.genzdigitalstore.com). The proxy has its own, completely
 *   separate server-side policy in claude-gateway/lib/{modelPolicy,effortPolicy}.js which
 *   this file does not import, share code with, or affect in any way. The two are
 *   deliberately independent: a change here must never be assumed to change the proxy,
 *   and vice versa. The POLICY VALUES below are mirrored from the proxy so a member sees
 *   the same rules on both paths — but they are mirrored by VALUE, not by import.
 *
 * POLICY
 *   MODEL   Fable 5 is disabled. Any fable variant -> claude-sonnet-5 (the approved model).
 *   EFFORT  Only Low and Medium. High / Extra / Max are hidden and blocked -> Medium.
 *
 * WHY MAIN WORLD, AT document_start
 *   The block has to happen on the OUTGOING request, not in CSS. A page's `fetch` reference
 *   is captured early by the SPA, so we must install before any app code runs. An ISOLATED
 *   world content script cannot see or patch the page's own fetch/XHR at all.
 *
 * HONEST LIMIT — DO NOT OVERSTATE THIS FILE
 *   A MAIN-world patch raises the bar a long way (stale storage, cached preferences, the
 *   app's own UI and its saved conversations can no longer produce a blocked value) but it
 *   is NOT an absolute guarantee against a determined user with devtools: anything running
 *   in the page can, in principle, open a socket we did not wrap. Chrome offers no
 *   extension API that closes that gap — declarativeNetRequest cannot read or rewrite a
 *   request BODY, which is where the model and effort live. The only tamper-proof
 *   enforcement point is server-side, which is exactly what the proxy gateway does.
 *   Treat this as strong client-side enforcement, not as a security boundary.
 *
 * SAFETY RULES OBSERVED
 *   - Rewrites only ever go BLOCKED -> allowed. No path here can emit fable/high/extra/max.
 *   - An unrecognised value is LEFT ALONE. Guessing would corrupt a request we don't model.
 *   - Prose is never touched: a value is only treated as a model id if it has model-id
 *     SHAPE, so a member typing the word "fable" into the composer is unaffected.
 *   - If anything in here throws, the original request proceeds untouched. A policy bug
 *     must never take Claude offline for a paying member.
 */
(function () {
  'use strict';

  // Idempotent: the background may re-inject after a navigation.
  if (window.__GENZ_CLAUDE_ENFORCER__) return;
  window.__GENZ_CLAUDE_ENFORCER__ = true;

  // ── Policy core (pure — no DOM, no I/O; mirrored from the proxy BY VALUE) ─────────────

  /** The approved model every blocked model becomes. */
  var FALLBACK_MODEL = 'claude-sonnet-5';
  /** Matches every fable variant, present and future (claude-fable-5, fable-5-latest, …). */
  var BLOCKED_MODEL_RE = /fable/i;
  /** Keys whose value is a model identifier. */
  var MODEL_KEY_RE = /^(model|model_?name|model_?id|default_?model|preferred_?model|paprika_?model|target_?model|fallback_?model)$/i;
  /** Keys whose value is an effort/thinking level. */
  var EFFORT_KEY_RE = /^(effort|effort_?level|reasoning_?effort|reasoning_?level|thinking_?effort|thinking_?level|thinking_?mode|paprika_?mode)$/i;

  var ALLOWED_EFFORTS = ['low', 'medium'];
  var DEFAULT_EFFORT = 'medium';

  /** Full vocabulary we can RECOGNISE — deliberately wider than the allowlist, so a saved
   *  "Extra High" preference can be detected and migrated rather than silently passed on. */
  var EFFORT_VOCAB = {
    low: 'low', lo: 'low', light: 'low', minimal: 'low', fast: 'low', quick: 'low',
    medium: 'medium', med: 'medium', mid: 'medium', standard: 'medium', normal: 'medium',
    balanced: 'medium', default: 'medium', base: 'medium',
    high: 'high', hi: 'high', deep: 'high',
    extra: 'extra', extrahigh: 'extra', veryhigh: 'extra', higher: 'extra',
    max: 'max', maximum: 'max', highest: 'max', ultra: 'max', maximal: 'max'
  };

  /** Strip separators/case so extra_high, extraHigh, "Extra High" and EXTRA-HIGH all agree. */
  function foldEffort(v) {
    return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s._-]+/g, '');
  }

  /** Canonicalise to low|medium|high|extra|max, or null when it is not an effort word.
   *  null is the "leave it alone" signal used by every caller. */
  function canonicalEffort(v) {
    if (v == null || typeof v === 'object') return null;
    var f = foldEffort(v);
    return Object.prototype.hasOwnProperty.call(EFFORT_VOCAB, f) ? EFFORT_VOCAB[f] : null;
  }

  function isEffortAllowed(v) {
    var c = canonicalEffort(v);
    return c != null && ALLOWED_EFFORTS.indexOf(c) !== -1;
  }

  /** Blocked effort -> medium. Allowed stays byte-identical. Unrecognised is returned as-is. */
  function sanitizeEffort(v) {
    var c = canonicalEffort(v);
    if (c == null) return v;                                  // not an effort word — leave alone
    if (ALLOWED_EFFORTS.indexOf(c) !== -1) return v;           // low / medium — untouched
    return DEFAULT_EFFORT;                                     // high / extra / max -> medium
  }

  /** Model-id SHAPE test. This is what keeps prose safe: "let's write a fable" is not a
   *  model id, `claude-fable-5` is. Bounded length so a paragraph can never qualify. */
  function looksLikeModelId(v) {
    return typeof v === 'string' && v.length > 0 && v.length <= 64 &&
      /^[a-z0-9]+(?:[._-][a-z0-9.]+)+$/i.test(v);
  }

  function isBlockedModel(v) {
    return typeof v === 'string' && BLOCKED_MODEL_RE.test(v);
  }

  function sanitizeModel(v) {
    return isBlockedModel(v) ? FALLBACK_MODEL : v;
  }

  /**
   * Deep-walk a decoded JSON value and rewrite blocked model/effort values in place-by-copy.
   * Returns { value, changed }. `changed` false means the caller MUST forward the original
   * bytes untouched — re-serialising a body we did not need to change risks altering
   * key order or number formatting that the app may depend on.
   */
  function sanitizeTree(node, depth) {
    depth = depth || 0;
    if (depth > 12 || node == null) return { value: node, changed: false };

    if (Array.isArray(node)) {
      var arrChanged = false;
      var arr = new Array(node.length);
      for (var i = 0; i < node.length; i++) {
        var ri = sanitizeTree(node[i], depth + 1);
        arr[i] = ri.value;
        if (ri.changed) arrChanged = true;
      }
      return { value: arrChanged ? arr : node, changed: arrChanged };
    }

    if (typeof node === 'object') {
      var objChanged = false;
      var out = {};
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];

        if (typeof v === 'string' && MODEL_KEY_RE.test(k) && isBlockedModel(v)) {
          out[k] = FALLBACK_MODEL; objChanged = true; continue;
        }
        if (EFFORT_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number')) {
          var se = sanitizeEffort(v);
          if (se !== v) { out[k] = se; objChanged = true; continue; }
        }
        // Fail-closed backstop for key names we do not model: a bare model-ID-shaped
        // string carrying "fable" is a model reference wherever it appears.
        if (typeof v === 'string' && looksLikeModelId(v) && isBlockedModel(v)) {
          out[k] = FALLBACK_MODEL; objChanged = true; continue;
        }

        var rv = sanitizeTree(v, depth + 1);
        out[k] = rv.value;
        if (rv.changed) objChanged = true;
      }
      return { value: objChanged ? out : node, changed: objChanged };
    }

    return { value: node, changed: false };
  }

  /** Sanitise a JSON string body. Returns null when nothing needed changing. */
  function sanitizeJsonBody(text) {
    if (typeof text !== 'string' || !text) return null;
    // Cheap pre-filter: if neither a fable token nor a blocked effort word appears, skip
    // the parse entirely. This keeps the hot path (every message you send) allocation-free.
    if (!/fable|high|extra|max|ultra|effort|paprika|thinking/i.test(text)) return null;
    var parsed;
    try { parsed = JSON.parse(text); } catch (_) { return null; }
    var r = sanitizeTree(parsed, 0);
    if (!r.changed) return null;
    try { return JSON.stringify(r.value); } catch (_) { return null; }
  }

  /** Sanitise query parameters on a URL. Returns null when nothing needed changing. */
  function sanitizeUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.indexOf('?') === -1) return null;
    var u;
    try { u = new URL(rawUrl, location.href); } catch (_) { return null; }
    var changed = false;
    u.searchParams.forEach(function (val, key) {
      if (MODEL_KEY_RE.test(key) && isBlockedModel(val)) {
        u.searchParams.set(key, FALLBACK_MODEL); changed = true;
      } else if (EFFORT_KEY_RE.test(key)) {
        var se = sanitizeEffort(val);
        if (se !== val) { u.searchParams.set(key, String(se)); changed = true; }
      }
    });
    return changed ? u.toString() : null;
  }

  /** Sanitise a URLSearchParams / FormData body in place. Returns true when it changed. */
  function sanitizeEntryBody(body) {
    var changed = false;
    var updates = [];
    try {
      body.forEach(function (val, key) {
        if (typeof val !== 'string') return;
        if (MODEL_KEY_RE.test(key) && isBlockedModel(val)) updates.push([key, FALLBACK_MODEL]);
        else if (EFFORT_KEY_RE.test(key)) {
          var se = sanitizeEffort(val);
          if (se !== val) updates.push([key, String(se)]);
        }
      });
      for (var i = 0; i < updates.length; i++) { body.set(updates[i][0], updates[i][1]); changed = true; }
    } catch (_) { return false; }
    return changed;
  }

  // Expose the pure core for the regression tests (and for nothing else — no behaviour
  // anywhere in this file reads it back).
  window.__GENZ_CLAUDE_POLICY__ = {
    FALLBACK_MODEL: FALLBACK_MODEL,
    ALLOWED_EFFORTS: ALLOWED_EFFORTS.slice(),
    DEFAULT_EFFORT: DEFAULT_EFFORT,
    canonicalEffort: canonicalEffort,
    isEffortAllowed: isEffortAllowed,
    sanitizeEffort: sanitizeEffort,
    isBlockedModel: isBlockedModel,
    sanitizeModel: sanitizeModel,
    looksLikeModelId: looksLikeModelId,
    sanitizeTree: sanitizeTree,
    sanitizeJsonBody: sanitizeJsonBody,
    sanitizeUrl: sanitizeUrl,
    sanitizeEntryBody: sanitizeEntryBody
  };

  // ── Request-path enforcement ─────────────────────────────────────────────────────────

  var nativeFetch = window.fetch;

  /** Wrap whatever function is currently acting as the page's fetch transport. */
  function wrapFetch(inner) {
    return function fetch(input, init) {
      try {
        var newInit = init;
        var newInput = input;

        // 1. URL query parameters (both the string form and a Request object).
        var urlStr = typeof newInput === 'string' ? newInput
          : (newInput && typeof newInput.url === 'string' ? newInput.url : null);
        var fixedUrl = urlStr ? sanitizeUrl(urlStr) : null;
        if (fixedUrl && typeof newInput === 'string') newInput = fixedUrl;

        // 2. Body on the init object — the common path for Claude's completion calls.
        if (newInit && newInit.body != null) {
          var b = newInit.body;
          if (typeof b === 'string') {
            var fixed = sanitizeJsonBody(b);
            if (fixed != null) { newInit = shallowCopy(newInit); newInit.body = fixed; }
          } else if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) {
            if (sanitizeEntryBody(b)) { /* mutated in place */ }
          } else if (typeof FormData !== 'undefined' && b instanceof FormData) {
            sanitizeEntryBody(b);
          }
          // Blob / ArrayBuffer / ReadableStream bodies are not used by the model or effort
          // pickers; they are forwarded untouched rather than buffered, so uploads and
          // streamed requests keep working exactly as they do today.
        }

        // 3. A Request object carrying its own body: re-read it, sanitise, rebuild. Only
        //    done when a blocked value is actually present (checked after the text read).
        if (!newInit && newInput && typeof Request !== 'undefined' && newInput instanceof Request &&
            newInput.method && newInput.method.toUpperCase() !== 'GET' && newInput.body) {
          var req = newInput;
          return req.clone().text().then(function (txt) {
            var fixedBody = sanitizeJsonBody(txt);
            if (fixedBody == null) return inner.call(window, fixedUrl ? new Request(fixedUrl, req) : req);
            return inner.call(window, new Request(fixedUrl || req.url, {
              method: req.method, headers: req.headers, body: fixedBody,
              mode: req.mode, credentials: req.credentials, cache: req.cache,
              redirect: req.redirect, referrer: req.referrer, integrity: req.integrity
            }));
          }, function () { return inner.call(window, req); });
        }

        return inner.call(window, newInput, newInit);
      } catch (_) {
        // Never let a policy bug break the app.
        return inner.call(window, input, init);
      }
    };
  }

  function shallowCopy(o) {
    var c = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
    return c;
  }

  // Install fetch as an ACCESSOR rather than a frozen value. Claude's own code (and its
  // telemetry/instrumentation) may legitimately reassign window.fetch; freezing it would
  // throw in strict mode and break the app. Instead we keep the wrapper as the visible
  // value and re-wrap anything the page assigns, so enforcement survives a page-side
  // override without ever taking a capability away from the app.
  var currentFetch = wrapFetch(nativeFetch);
  try {
    Object.defineProperty(window, 'fetch', {
      configurable: false,
      enumerable: true,
      get: function () { return currentFetch; },
      set: function (fn) { currentFetch = (typeof fn === 'function') ? wrapFetch(fn) : currentFetch; }
    });
  } catch (_) { try { window.fetch = currentFetch; } catch (__) {} }

  // XMLHttpRequest — same policy, applied to open() (URL) and send() (body).
  try {
    var XHR = XMLHttpRequest.prototype;
    var nativeOpen = XHR.open;
    var nativeSend = XHR.send;

    Object.defineProperty(XHR, 'open', {
      configurable: false, enumerable: false, writable: false,
      value: function open(method, url) {
        try {
          if (typeof url === 'string') {
            var fixed = sanitizeUrl(url);
            if (fixed) { arguments[1] = fixed; }
          }
        } catch (_) {}
        return nativeOpen.apply(this, arguments);
      }
    });

    Object.defineProperty(XHR, 'send', {
      configurable: false, enumerable: false, writable: false,
      value: function send(body) {
        try {
          if (typeof body === 'string') {
            var fixed = sanitizeJsonBody(body);
            if (fixed != null) return nativeSend.call(this, fixed);
          } else if (body && typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
            sanitizeEntryBody(body);
          } else if (body && typeof FormData !== 'undefined' && body instanceof FormData) {
            sanitizeEntryBody(body);
          }
        } catch (_) {}
        return nativeSend.apply(this, arguments);
      }
    });
  } catch (_) {}

  // navigator.sendBeacon — used for preference/telemetry writes that can carry a pinned model.
  try {
    var nativeBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (nativeBeacon) {
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: false, enumerable: false, writable: false,
        value: function sendBeacon(url, data) {
          try {
            var u = (typeof url === 'string' && sanitizeUrl(url)) || url;
            if (typeof data === 'string') {
              var fixed = sanitizeJsonBody(data);
              if (fixed != null) return nativeBeacon(u, fixed);
            }
            return nativeBeacon(u, data);
          } catch (_) { return nativeBeacon(url, data); }
        }
      });
    }
  } catch (_) {}

  // ── Stored-preference enforcement ────────────────────────────────────────────────────
  // A saved conversation or a cached preference pinned to Fable / High / Extra / Max must
  // not be able to reintroduce a blocked value on the next request. We migrate what is
  // already stored, then keep watch on writes.

  function sanitizeStoredValue(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    var asJson = sanitizeJsonBody(raw);
    if (asJson != null) return asJson;
    // Bare scalar values, e.g. localStorage.setItem('effort', 'max').
    if (isBlockedModel(raw) && looksLikeModelId(raw)) return FALLBACK_MODEL;
    var c = canonicalEffort(raw);
    if (c != null && ALLOWED_EFFORTS.indexOf(c) === -1) return DEFAULT_EFFORT;
    return null;
  }

  function migrateStore(store) {
    if (!store) return;
    try {
      var keys = [];
      for (var i = 0; i < store.length; i++) keys.push(store.key(i));
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        if (k == null) continue;
        var fixed = sanitizeStoredValue(store.getItem(k));
        if (fixed != null) store.setItem(k, fixed);
      }
    } catch (_) {}
  }

  try { migrateStore(window.localStorage); } catch (_) {}
  try { migrateStore(window.sessionStorage); } catch (_) {}

  // Guard future writes so a stale value cannot be re-pinned mid-session.
  try {
    var nativeSetItem = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, 'setItem', {
      configurable: false, enumerable: false, writable: false,
      value: function setItem(key, value) {
        try {
          var fixed = sanitizeStoredValue(value);
          if (fixed != null) return nativeSetItem.call(this, key, fixed);
        } catch (_) {}
        return nativeSetItem.apply(this, arguments);
      }
    });
  } catch (_) {}

  // ── UI removal (belt, not the enforcement) ───────────────────────────────────────────
  // The request path above is what actually blocks. Hiding the entries as well means a
  // member is never offered something that will be silently downgraded — which is a much
  // clearer experience than a picker that appears to work but doesn't.

  var BLOCKED_MENU_RE = /^(fable(\s*5)?|claude\s+fable(\s*5)?|high|extra(\s*high)?|very\s*high|max(imum)?|highest|ultra)$/i;

  function sweepMenus(root) {
    var nodes;
    try {
      nodes = (root || document).querySelectorAll('[role="menuitem"],[role="option"],[role="menuitemradio"]');
    } catch (_) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.__genzChecked) continue;
      el.__genzChecked = true;
      var txt = '';
      try { txt = (el.textContent || '').trim().replace(/\s+/g, ' '); } catch (_) {}
      if (!txt || txt.length > 24) continue;   // long text is prose, not a picker entry
      if (BLOCKED_MENU_RE.test(txt)) {
        try {
          el.style.setProperty('display', 'none', 'important');
          el.setAttribute('aria-hidden', 'true');
        } catch (_) {}
      }
    }
  }

  function startSweeper() {
    try {
      sweepMenus(document);
      var obs = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            if (added[j] && added[j].nodeType === 1) sweepMenus(added[j].parentNode || document);
          }
        }
      });
      obs.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startSweeper, { once: true });
  } else {
    startSweeper();
  }
})();
