/**
 * useExtension.js — React hook for dashboard ↔ extension communication.
 *
 * Flow for tool opens:
 *  1. Call openTool(toolId) from an Access button.
 *  2. Hook calls POST /api/crm/client/tools/:toolId/open-intent → gets intentToken (60s TTL).
 *  3. Sends GENZ_OPEN_TOOL via postMessage → bridge.js → background.js.
 *  4. background.js verifies intent with backend, fetches credentials, opens tab.
 *  5. Returns { success, method, error } — NO credentials ever reach the page.
 *
 * Security guarantees:
 *  - Credentials never leave the extension service worker.
 *  - Every open is gated by a server-verified short-lived intent token.
 *  - Bridge.js strips any sensitive fields before passing results to the page.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';

// Extension detection is bridge-based, so REACT_APP_EXTENSION_ID is optional.
const BRIDGE_TIMEOUT_MS = 15000; // 15 seconds max wait for extension response

function getBackendOrigin() {
  const envUrl = process.env.REACT_APP_BACKEND_URL;
  if (envUrl) {
    try { return new URL(envUrl).origin; } catch (_) {}
  }
  return window.location.origin;
}

function getWebsiteDeviceId() {
  let id = localStorage.getItem('device_id');
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `web_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('device_id', id);
  }
  return id;
}

// ── Detect extension via postMessage bridge ──────────────────────────────────
function sendToBridge(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = `${type}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expectedType = `${type}_RESPONSE`;

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Extension did not respond in time'));
    }, BRIDGE_TIMEOUT_MS);

    const handler = (event) => {
      if (
        event.source !== window ||
        event.data?.type !== expectedType ||
        event.data?.requestId !== requestId
      ) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      if (event.data.success === false) {
        reject(new Error(event.data.error || 'Extension error'));
      } else {
        resolve(event.data);
      }
    };

    window.addEventListener('message', handler);
    window.postMessage({ type, requestId, payload }, window.location.origin);
  });
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useExtension() {
  const [status, setStatus] = useState(null); // null=checking, object otherwise
  const [bridgeReady, setBridgeReady] = useState(false);
  const openingRef = useRef(new Map()); // toolId → true

  // Listen for bridge-ready signals and background push events. Detection is
  // independent of Chrome extension ID, so a new Load unpacked ID will not break
  // the dashboard. The bridge also writes DOM markers that we poll as fallback.
  useEffect(() => {
    let cancelled = false;
    let pollingTimer = null;

    const markBridgeReady = () => {
      if (cancelled) return;
      setBridgeReady(true);
    };

    const refreshStatus = async () => {
      try {
        const resp = await sendToBridge('GENZ_GET_EXTENSION_STATUS');
        if (cancelled) return;
        setBridgeReady(true);
        setStatus({
          installed: true,
          connected: !!resp.connected,
          version: resp.version,
          toolCount: resp.toolCount || 0,
          lastSync: resp.lastSync || null,
          reason: resp.connected ? null : (resp.reason || 'not_connected')
        });
      } catch (_) {
        if (!cancelled) {
          const marker = document.documentElement.getAttribute('data-genz-extension-ready');
          const version = document.documentElement.getAttribute('data-genz-extension-version');
          if (marker === 'true') {
            setBridgeReady(true);
            setStatus(prev => ({ ...(prev || {}), installed: true, connected: false, version, reason: 'bridge_ready_waiting_for_status' }));
          } else {
            setStatus({ installed: false, connected: false, reason: 'extension_not_detected' });
          }
        }
      }
    };

    const messageHandler = (event) => {
      if (event.source !== window) return;
      const { type } = event.data || {};

      if (type === 'GENZ_BRIDGE_READY') {
        markBridgeReady();
        refreshStatus();
      }

      if (type === 'GENZ_EXTENSION_DISCONNECTED') {
        setStatus(prev => ({ ...(prev || {}), installed: true, connected: false, reason: event.data.reason }));
      }

      if (type === 'GENZ_SYNC_COMPLETE') {
        setStatus(prev => ({ ...(prev || {}), toolCount: event.data.toolCount, lastSync: event.data.lastSync }));
      }
    };

    const eventHandler = () => {
      markBridgeReady();
      refreshStatus();
    };

    window.addEventListener('message', messageHandler);
    document.addEventListener('GENZ_BRIDGE_READY', eventHandler);

    // Immediate + repeated probes catch already-injected bridge.js.
    refreshStatus();
    let attempts = 0;
    pollingTimer = setInterval(() => {
      attempts += 1;
      const marker = document.documentElement.getAttribute('data-genz-extension-ready');
      if (marker === 'true') markBridgeReady();
      refreshStatus();
      if (attempts >= 20 || cancelled) clearInterval(pollingTimer);
    }, 500);

    return () => {
      cancelled = true;
      if (pollingTimer) clearInterval(pollingTimer);
      window.removeEventListener('message', messageHandler);
      document.removeEventListener('GENZ_BRIDGE_READY', eventHandler);
    };
  }, []);

  /**
   * Pair/connect the extension. Prefer website-session activation token so the
   * member does not need to login in the extension popup. Email/password is kept
   * only as a fallback for legacy/manual setup.
   */
  const connectExtension = useCallback(async (credentials = {}) => {
    if (!bridgeReady) throw new Error('Extension not detected');
    const apiUrl = getBackendOrigin();
    let payload = { apiUrl };

    if (credentials?.email && credentials?.password) {
      payload = { ...payload, email: credentials.email, password: credentials.password };
    } else {
      const activation = await api.post('/client/extension/activation-token', {
        deviceId: getWebsiteDeviceId()
      });
      payload = { ...payload, activationToken: activation.data.activationToken };
    }

    setStatus(prev => ({ ...prev, connecting: true, reason: null }));
    const resp = await sendToBridge('GENZ_CONNECT_EXTENSION', payload);
    setStatus(prev => ({ ...prev, connected: true, connecting: false, version: resp.version || prev?.version }));
    return resp;
  }, [bridgeReady]);

  // When the bridge is ready, connect silently using the website session if the
  // extension is installed but not yet connected.
  useEffect(() => {
    if (!bridgeReady) return;
    let cancelled = false;
    (async () => {
      try {
        const current = await sendToBridge('GENZ_GET_EXTENSION_STATUS');
        if (cancelled) return;
        setStatus({
          connected: !!current.connected,
          version: current.version,
          toolCount: current.toolCount,
          lastSync: current.lastSync
        });
        if (!current.connected) {
          try {
            await connectExtension();
          } catch (err) {
            if (!cancelled) setStatus(prev => ({ ...prev, connected: false, reason: err.message }));
          }
        }
      } catch (err) {
        if (!cancelled) setStatus({ connected: false, reason: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [bridgeReady, connectExtension]);

  /**
   * Open a tool from the dashboard.
   * Returns { success, method, error, requiresManualAction }.
   * Never returns credentials.
   */
  const openTool = useCallback(async (toolId) => {
    if (!bridgeReady) {
      return { success: false, error: 'extension_not_detected', message: 'Extension not detected. Reload the extension, refresh this dashboard, then click Access again.' };
    }
    if (!status?.connected) {
      try {
        await connectExtension();
      } catch (err) {
        return {
          success: false,
          error: 'extension_not_connected',
          message: err.message || 'Extension is installed but could not auto-connect. Refresh dashboard or reload the extension.'
        };
      }
    }

    // Duplicate-open guard on the frontend side too
    if (openingRef.current.get(toolId)) {
      return { success: false, error: 'already_opening' };
    }
    openingRef.current.set(toolId, true);

    try {
      // 1. Get a short-lived server-issued intent token
      const intentResp = await api.post(`/client/tools/${toolId}/open-intent`, { deviceId: getWebsiteDeviceId() });
      const intentToken = intentResp.data.intentToken || intentResp.data.openIntentToken;

      if (!intentToken) {
        return { success: false, error: 'Could not get intent token from server' };
      }

      // 2. Forward to extension via bridge — credentials never touch this page
      let result = await sendToBridge('GENZ_OPEN_TOOL', { toolId, openIntentToken: intentToken });

      // If host permission is missing, request it from the same user gesture path,
      // then create a fresh intent and retry once. Credentials never touch the page.
      if (result?.error === 'permission_required' && result.originPattern) {
        const permission = await sendToBridge('GENZ_REQUEST_PERMISSION', { originPattern: result.originPattern });
        if (!permission?.success && !permission?.granted) return result;
        const retryIntent = await api.post(`/client/tools/${toolId}/open-intent`, { deviceId: getWebsiteDeviceId() });
        const retryToken = retryIntent.data.intentToken || retryIntent.data.openIntentToken;
        result = await sendToBridge('GENZ_OPEN_TOOL', { toolId, openIntentToken: retryToken });
      }
      return result;

    } catch (err) {
      const msg = err.message || 'Unknown error';

      // Handle known error codes
      if (msg.includes('permission_required')) {
        return { success: false, error: 'permission_required', message: 'Permission required for this tool domain. Click Access again and approve the browser prompt.' };
      }
      if (msg.includes('token') || msg.includes('401') || msg.includes('403')) {
        setStatus(prev => ({ ...prev, connected: false }));
        return { success: false, error: 'session_expired', message: 'Extension session expired. Reconnect from the extension popup.' };
      }
      return { success: false, error: msg };
    } finally {
      openingRef.current.delete(toolId);
    }
  }, [bridgeReady, status, connectExtension]);

  /**
   * Grant scanner consent — triggers one scan immediately.
   */
  const grantScanConsent = useCallback(async () => {
    if (!bridgeReady) throw new Error('Extension not detected');
    return sendToBridge('GENZ_SCAN_CONSENT');
  }, [bridgeReady]);

  /**
   * Revoke scanner consent.
   */
  const revokeScanConsent = useCallback(async () => {
    if (!bridgeReady) throw new Error('Extension not detected');
    return sendToBridge('GENZ_REVOKE_SCAN_CONSENT');
  }, [bridgeReady]);

  /**
   * Get current scanner status.
   */
  const getScanStatus = useCallback(async () => {
    if (!bridgeReady) return { consentGiven: false };
    return sendToBridge('GENZ_GET_SCAN_STATUS');
  }, [bridgeReady]);

  return { status, bridgeReady, openTool, connectExtension, grantScanConsent, revokeScanConsent, getScanStatus };
}
