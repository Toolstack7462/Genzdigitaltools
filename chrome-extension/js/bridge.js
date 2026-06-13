/**
 * bridge.js — Gen Z Digital Store dashboard bridge v3.7
 *
 * Goals:
 * - Detect installed extension without requiring a fixed extension ID.
 * - Auto-connect from an already logged-in dashboard session.
 * - Forward only safe dashboard commands to the background service worker.
 * - Survive extension reloads without crashing the page.
 */
'use strict';

if (globalThis.__GENZ_DASHBOARD_BRIDGE_V34__) {
  try {
    // safeVersion is defined in the else block; use inline fallback here
    const _ver = (() => { try { return chrome.runtime.getManifest().version || '3.8.0'; } catch (_) { return '3.8.0'; } })();
    window.postMessage({
      type: 'GENZ_BRIDGE_READY',
      installed: true,
      version: _ver,
      duplicate: true,
      ts: Date.now(),
    }, window.location.origin);
  } catch (_) {}
} else {
  globalThis.__GENZ_DASHBOARD_BRIDGE_V34__ = true;

  const ALLOWED_ORIGINS = new Set([
    'https://genzdigitalstore.com',
    'https://app.genzdigitalstore.com',
    'http://localhost:3000',
  ]);

  const ALLOWED_INBOUND = new Set([
    'GENZ_EXT_PING',
    'GENZ_GET_EXTENSION_STATUS',
    'GENZ_CONNECT_EXTENSION',
    'GENZ_OPEN_TOOL',
    'GENZ_RESET_EXTENSION_SESSION',
    'GENZ_REQUEST_PERMISSION',
    'GENZ_SCAN_CONSENT',
    'GENZ_REVOKE_SCAN_CONSENT',
    'GENZ_GET_SCAN_STATUS',
  ]);

  const SAFE_PUSH_TYPES = new Set([
    'GENZ_EXTENSION_CONNECTED',
    'GENZ_EXTENSION_DISCONNECTED',
    'GENZ_SYNC_COMPLETE',
    'GENZ_TOOL_UPDATED',
    'GENZ_FORCE_RECONNECT',
  ]);

  const STRIP_FROM_RESPONSE = new Set([
    'credentials', 'sessionBundle', 'cookies', 'token', 'password',
    'cookiesEncrypted', 'tokenEncrypted', 'localStorageEncrypted',
    'payloadEncrypted', 'extensionToken', 'secret', 'refreshToken', 'accessToken',
  ]);

  function safeVersion() {
    try {
      if (chrome?.runtime?.getManifest) return chrome.runtime.getManifest().version || '3.7.0';
    } catch (_) {}
    return '3.7.0';
  }

  function contextAlive() {
    try { return !!(chrome?.runtime?.id); } catch (_) { return false; }
  }

  function isAllowedOrigin(origin) {
    try { return ALLOWED_ORIGINS.has(new URL(origin).origin); } catch (_) { return false; }
  }

  function sanitize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sanitize);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (STRIP_FROM_RESPONSE.has(k)) continue;
      out[k] = (v && typeof v === 'object') ? sanitize(v) : v;
    }
    return out;
  }

  function setMarkers(status = {}) {
    try {
      document.documentElement.setAttribute('data-genz-extension-ready', 'true');
      document.documentElement.setAttribute('data-genz-extension-version', safeVersion());
      if (status.connected != null) {
        document.documentElement.setAttribute('data-genz-extension-connected', String(!!status.connected));
      }
    } catch (_) {}
  }

  function postToPage(payload) {
    try {
      window.postMessage({
        source: 'GENZ_DIGITAL_STORE_EXTENSION',
        ...sanitize(payload),
        ts: Date.now(),
      }, window.location.origin);
    } catch (_) {}
  }

  function sendToBackground(type, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!contextAlive()) return reject(new Error('Extension context invalidated. Refresh the dashboard.'));
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) reject(new Error(lastErr.message));
          else resolve(response || {});
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function postBridgeReady() {
    if (!contextAlive()) {
      setMarkers({ connected: false });
      postToPage({
        type: 'GENZ_EXTENSION_CONTEXT_INVALIDATED',
        installed: false,
        connected: false,
        message: 'Extension was reloaded. Refresh the dashboard.',
      });
      return false;
    }

    let status = { connected: false };
    try {
      status = await sendToBackground('GENZ_GET_EXTENSION_STATUS', {});
    } catch (_) {}

    setMarkers(status);
    try {
      document.dispatchEvent(new CustomEvent('GENZ_BRIDGE_READY', { detail: status }));
    } catch (_) {}

    postToPage({
      type: 'GENZ_BRIDGE_READY',
      installed: true,
      connected: !!status.connected,
      version: safeVersion(),
      toolCount: status.toolCount || 0,
      lastSync: status.lastSync || null,
      reason: status.reason || null,
    });
    return true;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !isAllowedOrigin(event.origin)) return;
    const { type, requestId, payload } = event.data || {};
    if (!type || !ALLOWED_INBOUND.has(type) || typeof requestId !== 'string') return;

    try {
      const response = await sendToBackground(type, payload || {});
      const safe = sanitize(response);
      window.postMessage({
        source: 'GENZ_DIGITAL_STORE_EXTENSION',
        type: `${type}_RESPONSE`,
        requestId,
        success: safe.success !== false,
        ...safe,
      }, event.origin);
    } catch (err) {
      window.postMessage({
        source: 'GENZ_DIGITAL_STORE_EXTENSION',
        type: `${type}_RESPONSE`,
        requestId,
        success: false,
        error: err.message || 'Extension error',
      }, event.origin);
    }
  });

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !SAFE_PUSH_TYPES.has(message.type)) return;
      postToPage(message);
      if (message.type === 'GENZ_EXTENSION_CONNECTED') setMarkers({ connected: true });
      if (message.type === 'GENZ_EXTENSION_DISCONNECTED') setMarkers({ connected: false });
    });
  } catch (_) {}

  postBridgeReady();
  let ticks = 0;
  const timer = setInterval(async () => {
    ticks += 1;
    const ok = await postBridgeReady();
    if (!ok || ticks >= 120) clearInterval(timer);
  }, 500);
}
