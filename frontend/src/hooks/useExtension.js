/**
 * useExtension.js — robust dashboard ↔ extension communication v3.4
 *
 * The extension is detected through bridge.js heartbeats, not by a fixed Chrome
 * extension ID. If the user loads the unpacked extension while the dashboard is
 * already open, background.js injects bridge.js and this hook auto-pairs using
 * the logged-in client session.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';

const BRIDGE_TIMEOUT_MS = 15000;
const AUTO_CONNECT_MAX_ATTEMPTS = 8;

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

function getBridgeMarker() {
  return document.documentElement.getAttribute('data-genz-extension-ready') === 'true';
}

function sendToBridge(type, payload = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const requestId = `${type}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expectedType = `${type}_RESPONSE`;

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Extension did not respond in time'));
    }, timeoutMs);

    const handler = (event) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.type !== expectedType || data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      if (data.success === false) reject(new Error(data.error || 'Extension error'));
      else resolve(data);
    };

    window.addEventListener('message', handler);
    window.postMessage({
      source: 'GENZ_DIGITAL_STORE_DASHBOARD',
      type,
      requestId,
      payload,
    }, window.location.origin);
  });
}

export function useExtension() {
  const [status, setStatus] = useState({ installed: false, connected: false, checking: true });
  const [bridgeReady, setBridgeReady] = useState(false);
  const openingRef = useRef(new Map());
  const connectPromiseRef = useRef(null);
  const autoConnectAttemptsRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    try {
      const resp = await sendToBridge('GENZ_GET_EXTENSION_STATUS', {}, 5000);
      setBridgeReady(true);
      const next = {
        installed: true,
        connected: !!resp.connected,
        checking: false,
        version: resp.version,
        toolCount: resp.toolCount || 0,
        lastSync: resp.lastSync || null,
        reason: resp.connected ? null : (resp.reason || 'not_connected'),
      };
      setStatus(next);
      return next;
    } catch (err) {
      if (getBridgeMarker()) {
        const version = document.documentElement.getAttribute('data-genz-extension-version');
        setBridgeReady(true);
        const next = { installed: true, connected: false, checking: false, version, reason: err.message };
        setStatus(next);
        return next;
      }
      const next = { installed: false, connected: false, checking: false, reason: 'extension_not_detected' };
      setStatus(next);
      return next;
    }
  }, []);

  const connectExtension = useCallback(async (credentials = {}) => {
    if (!bridgeReady && !getBridgeMarker()) throw new Error('Extension not detected');

    // Prevent duplicate activation-token consumption during multiple heartbeats.
    if (connectPromiseRef.current) return connectPromiseRef.current;

    connectPromiseRef.current = (async () => {
      const apiUrl = getBackendOrigin();
      let payload = { apiUrl };

      if (credentials?.email && credentials?.password) {
        payload = { ...payload, email: credentials.email, password: credentials.password };
      } else {
        const activation = await api.post('/client/extension/activation-token', {
          deviceId: getWebsiteDeviceId(),
        });
        payload = { ...payload, activationToken: activation.data.activationToken };
      }

      setStatus(prev => ({ ...(prev || {}), installed: true, connecting: true, reason: null }));
      const resp = await sendToBridge('GENZ_CONNECT_EXTENSION', payload, 15000);

      if (resp.success === false) throw new Error(resp.error || 'Extension connection failed');

      const next = {
        installed: true,
        connected: true,
        connecting: false,
        checking: false,
        version: resp.version,
        toolCount: resp.toolCount || 0,
        lastSync: resp.lastSync || new Date().toISOString(),
        reason: null,
      };
      setBridgeReady(true);
      setStatus(next);
      return resp;
    })();

    try {
      return await connectPromiseRef.current;
    } finally {
      connectPromiseRef.current = null;
    }
  }, [bridgeReady]);

  // Detect bridge readiness. This supports extension loaded after page open.
  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const markReady = () => {
      if (cancelled) return;
      setBridgeReady(true);
      refreshStatus();
    };

    const messageHandler = (event) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.type === 'GENZ_BRIDGE_READY') {
        setBridgeReady(true);
        setStatus(prev => ({
          ...(prev || {}),
          installed: true,
          checking: false,
          connected: !!data.connected,
          version: data.version || prev?.version,
          toolCount: data.toolCount || prev?.toolCount || 0,
          lastSync: data.lastSync || prev?.lastSync || null,
        }));
      }
      if (data.type === 'GENZ_EXTENSION_CONNECTED') {
        setBridgeReady(true);
        setStatus(prev => ({ ...(prev || {}), installed: true, connected: true, checking: false, reason: null }));
      }
      if (data.type === 'GENZ_EXTENSION_DISCONNECTED') {
        setStatus(prev => ({ ...(prev || {}), installed: true, connected: false, checking: false, reason: data.reason || 'disconnected' }));
      }
      if (data.type === 'GENZ_SYNC_COMPLETE') {
        setStatus(prev => ({ ...(prev || {}), toolCount: data.toolCount, lastSync: data.lastSync }));
      }
    };

    window.addEventListener('message', messageHandler);
    document.addEventListener('GENZ_BRIDGE_READY', markReady);

    refreshStatus();
    let attempts = 0;
    timer = setInterval(() => {
      attempts += 1;
      if (getBridgeMarker()) setBridgeReady(true);
      refreshStatus();
      if (attempts >= 60 || cancelled) clearInterval(timer);
    }, 500);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener('message', messageHandler);
      document.removeEventListener('GENZ_BRIDGE_READY', markReady);
    };
  }, [refreshStatus]);

  // Auto-connect from the client dashboard session. Retry a few times because
  // extension service workers and content scripts can wake up slightly later.
  useEffect(() => {
    if (!bridgeReady) return;
    let cancelled = false;
    let retryTimer = null;

    const attempt = async () => {
      if (cancelled) return;
      const current = await refreshStatus();
      if (current?.connected) return;
      if (autoConnectAttemptsRef.current >= AUTO_CONNECT_MAX_ATTEMPTS) return;
      autoConnectAttemptsRef.current += 1;
      try {
        await connectExtension();
        await refreshStatus();
      } catch (err) {
        if (!cancelled) {
          setStatus(prev => ({ ...(prev || {}), installed: true, connected: false, checking: false, reason: err.message }));
          retryTimer = setTimeout(attempt, 1500);
        }
      }
    };

    attempt();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [bridgeReady, connectExtension, refreshStatus]);

  const openTool = useCallback(async (toolId) => {
    if (!bridgeReady && !getBridgeMarker()) {
      return { success: false, error: 'extension_not_detected', message: 'Extension not detected. Reload the extension or refresh the dashboard.' };
    }

    let current = await refreshStatus();
    if (!current?.connected) {
      try {
        await connectExtension();
        current = await refreshStatus();
      } catch (err) {
        return { success: false, error: 'extension_not_connected', message: err.message || 'Extension could not auto-connect.' };
      }
    }

    if (openingRef.current.get(toolId)) return { success: false, error: 'already_opening' };
    openingRef.current.set(toolId, true);

    try {
      const intentResp = await api.post(`/client/tools/${toolId}/open-intent`, { deviceId: getWebsiteDeviceId() });
      const intentToken = intentResp.data.intentToken || intentResp.data.openIntentToken;
      if (!intentToken) return { success: false, error: 'missing_intent_token' };

      let result = await sendToBridge('GENZ_OPEN_TOOL', { toolId, openIntentToken: intentToken }, 20000);

      if (result?.error === 'permission_required' && result.originPattern) {
        const permission = await sendToBridge('GENZ_REQUEST_PERMISSION', { originPattern: result.originPattern }, 20000);
        if (!permission?.success && !permission?.granted) return result;
        const retryIntent = await api.post(`/client/tools/${toolId}/open-intent`, { deviceId: getWebsiteDeviceId() });
        const retryToken = retryIntent.data.intentToken || retryIntent.data.openIntentToken;
        result = await sendToBridge('GENZ_OPEN_TOOL', { toolId, openIntentToken: retryToken }, 20000);
      }

      return result;
    } catch (err) {
      const msg = err.message || 'Unknown error';
      if (msg.includes('token') || msg.includes('401') || msg.includes('403')) {
        setStatus(prev => ({ ...(prev || {}), connected: false }));
        return { success: false, error: 'session_expired', message: 'Extension session expired. Refresh dashboard to auto-connect again.' };
      }
      return { success: false, error: msg, message: msg };
    } finally {
      openingRef.current.delete(toolId);
    }
  }, [bridgeReady, connectExtension, refreshStatus]);

  const grantScanConsent = useCallback(async () => {
    if (!bridgeReady && !getBridgeMarker()) throw new Error('Extension not detected');
    return sendToBridge('GENZ_SCAN_CONSENT');
  }, [bridgeReady]);

  const revokeScanConsent = useCallback(async () => {
    if (!bridgeReady && !getBridgeMarker()) throw new Error('Extension not detected');
    return sendToBridge('GENZ_REVOKE_SCAN_CONSENT');
  }, [bridgeReady]);

  const getScanStatus = useCallback(async () => {
    if (!bridgeReady && !getBridgeMarker()) return { consentGiven: false };
    return sendToBridge('GENZ_GET_SCAN_STATUS');
  }, [bridgeReady]);

  return { status, bridgeReady, openTool, connectExtension, grantScanConsent, revokeScanConsent, getScanStatus };
}
