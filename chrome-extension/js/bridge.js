/**
 * bridge.js — Content-Script Bridge (ISOLATED world)
 *
 * Injected only on approved origins:
 *   https://genzdigitalstore.com/*
 *   https://app.genzdigitalstore.com/*
 *   http://localhost:3000/*
 *
 * Security rules:
 *   - Runs in ISOLATED world — zero access to page JS variables.
 *   - Validates every postMessage origin before forwarding.
 *   - NEVER forwards credentials, cookies, tokens, or sessionBundle to the page.
 *   - Only passes safe status/result fields back to the website.
 *   - Extension token is kept in chrome.storage — never touches the page.
 */

'use strict';

// ── Allowed origins (must match manifest content_scripts.matches) ─────────────
const ALLOWED_ORIGINS = new Set([
  'https://genzdigitalstore.com',
  'https://app.genzdigitalstore.com',
  'http://localhost:3000',
]);

// ── Safe inbound message types the website may send ──────────────────────────
const ALLOWED_INBOUND = new Set([
  'GENZ_EXT_PING',
  'GENZ_GET_EXTENSION_STATUS',
  'GENZ_CONNECT_EXTENSION',
  'GENZ_OPEN_TOOL',
  'GENZ_REQUEST_PERMISSION',
  'GENZ_SCAN_CONSENT',
  'GENZ_REVOKE_SCAN_CONSENT',
  'GENZ_GET_SCAN_STATUS',
]);

// ── Fields that must NEVER be forwarded to the page ──────────────────────────
const STRIP_FROM_RESPONSE = new Set([
  'credentials', 'sessionBundle', 'cookies', 'token', 'password',
  'cookiesEncrypted', 'tokenEncrypted', 'localStorageEncrypted',
  'payloadEncrypted', 'extensionToken', 'secret',
]);

/**
 * Strip any sensitive keys recursively from an object
 * before sending it back to the page.
 */
function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_FROM_RESPONSE.has(k)) continue;
    out[k] = typeof v === 'object' && v !== null ? sanitize(v) : v;
  }
  return out;
}

/**
 * Validate that the event origin is an approved dashboard origin.
 */
function isAllowedOrigin(origin) {
  try {
    const o = new URL(origin).origin;
    return ALLOWED_ORIGINS.has(o);
  } catch {
    return false;
  }
}

// ── Listen for postMessage from the dashboard page ────────────────────────────
window.addEventListener('message', async (event) => {
  // 1. Validate origin
  if (!isAllowedOrigin(event.origin)) return;

  const { type, requestId, payload } = event.data || {};

  // 2. Validate message shape and type
  if (!type || !ALLOWED_INBOUND.has(type) || typeof requestId !== 'string') return;

  try {
    // 3. Forward to background, get response
    const response = await sendToBackground(type, payload || {});

    // 4. Strip any credentials/tokens from response before replying
    const safe = sanitize(response);

    // 5. Post safe result back to dashboard
    window.postMessage({
      type:      `${type}_RESPONSE`,
      requestId,
      success:   safe.success !== false,
      ...safe,
    }, event.origin);

  } catch (err) {
    window.postMessage({
      type:      `${type}_RESPONSE`,
      requestId,
      success:   false,
      error:     err.message || 'Extension error',
    }, event.origin);
  }
});

/**
 * Send a message to background.js and return a Promise for the response.
 */
function sendToBackground(type, payload) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response || {});
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ── Signal to the page that the bridge is ready ───────────────────────────────
window.postMessage({ type: 'GENZ_BRIDGE_READY', version: '3.0.0' }, window.location.origin);

// ── Listen for messages pushed FROM background (e.g. disconnection events) ──
// Background calls notifyDashboardTabs() which uses chrome.tabs.sendMessage → here.
chrome.runtime.onMessage.addListener((message) => {
  // Only forward safe status events to the page — never credentials
  const SAFE_PUSH_TYPES = new Set([
    'GENZ_EXTENSION_DISCONNECTED',
    'GENZ_SYNC_COMPLETE',
    'GENZ_TOOL_UPDATED',
  ]);
  if (!SAFE_PUSH_TYPES.has(message.type)) return;
  // Forward to the dashboard page
  window.postMessage({ ...message }, window.location.origin);
});
