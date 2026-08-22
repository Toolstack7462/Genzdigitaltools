/**
 * ZERO-FLASH bootstrap for the ChatGPT Chat/Work policy — chatgpt.com ONLY.
 *
 * THE BUG THIS FIXES. js/shield.js is injected by background.js from the
 * chrome.tabs.onUpdated listener, and that listener only fires at
 * `changeInfo.status === 'complete'` — i.e. AFTER the page has loaded and painted.
 * The service worker may also be dormant, adding wake-up latency on top. ChatGPT's
 * Chat|Work switcher is part of the INITIAL render, so the sequence was:
 *
 *     React renders Chat|Work  ->  PAINTED (member sees Work)  ->  'complete'
 *     ->  service worker wakes  ->  shield.js injected  ->  Work hidden
 *
 * That visible gap is the reported flash. It is a TIMING defect, not a policy defect —
 * the policy itself already hides synchronously from a MutationObserver microtask, which
 * runs before the next paint. It simply was not present yet when the first paint happened.
 *
 * THE FIX. This file is a DECLARATIVE content script registered in manifest.json at
 * `run_at: document_start`, so it is guaranteed to run before the page's own scripts and
 * before React's first render — with no service-worker round trip at all. It seeds a
 * MINIMAL config and then manifest.json loads js/shield.js immediately after it, in the
 * same ISOLATED world. shield.js installs its observer and capture guards at once, so the
 * Work segment is hidden in the same microtask it is inserted and never occupies a
 * painted frame.
 *
 * WHY THE CONFIG HERE IS MINIMAL. This bootstrap carries ONLY the tab policy. The
 * account/logout shield rules (href/attr/text/route) are deliberately left empty and
 * arrive later with the real, fully-resolved config from background.js — which may also
 * carry per-assignment overrides this file cannot know about. Seeding them here would
 * mean duplicating SHIELD_DEFAULTS and risking drift.
 *
 * Consequently shield.js's __GENZ_SHIELD_REFRESH__ MUST fully supersede every value
 * seeded here when the real config lands; that completeness is asserted by
 * test/chatgptWorkPolicy.test.js. Without it the ChatGPT account shield would be
 * permanently stuck on these empty placeholders.
 *
 * SCOPE. manifest.json matches chatgpt.com only, so no other tool, no other host and no
 * other extension feature can ever load this file. It is ISOLATED world and touches no
 * page globals, no cookies, no tokens and no storage.
 *
 * The tabPolicy literal below is a deliberate, test-guarded copy of the one in
 * js/config/toolConfigs.js (SHIELD_OVERRIDES['chatgpt.com'].tabPolicy). It cannot be
 * imported: that file is an ES module used by the service worker, and a content script
 * loaded this early must be a classic script. chatgptWorkPolicy.test.js compares the two
 * and fails on any drift.
 */
(function () {
  'use strict';

  // If background.js somehow already delivered the real config, never downgrade it.
  if (window.__GENZ_SHIELD_CFG__) return;

  window.__GENZ_SHIELD_CFG__ = {
    enabled: true,
    // Intentionally empty: the real account/logout rules arrive with the full config.
    // Empty sources make shield.js's HIDE_TEXT_RE / KEEP_TEXT_RE null, so the page-wide
    // text sweep is inert during the bootstrap window and cannot hide anything by guess.
    hrefSubstrings: [],
    attrSubstrings: [],
    hideSelectors: [],
    hideTextSource: '',
    keepTextSource: '',
    // Empty so the restricted-route popup cannot fire on a partial config.
    blockRouteFragments: [],
    tabPolicy: {
      rowSel: '[role="tab"],[role="radio"],[role="menuitemradio"],[role="option"],button,a[href],[tabindex]',
      blockLabelSource: '^work$',
      allowLabelSource: '^chat$',
      excludeHrefSource: '/c/|/g/|/gpts|/project|/codex',
      maxLabel: 12,
      maxClimb: 6,
      maxSwitchNodes: 120,
      requireSelectionMarker: true,
      maxRecoveries: 3
    }
  };
})();
