/**
 * useExtension.js — robust dashboard ↔ extension communication v3.7
 *
 * The extension is detected through bridge.js heartbeats, not by a fixed Chrome
 * extension ID. If the user loads the unpacked extension while the dashboard is
 * already open, background.js injects bridge.js and this hook auto-pairs using
 * the logged-in client session.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';

const BRIDGE_TIMEOUT_MS = 15000;
// Auto-connect uses exponential backoff and runs as long as the dashboard tab
// is open — we never "give up" silently. After this many consecutive failures
// we also automatically escalate to `forceReauth: true` to defeat any stale
// activation-token / device-binding state in the extension storage.
const AUTO_CONNECT_FORCE_REAUTH_AFTER = 3;
const AUTO_CONNECT_INITIAL_DELAY_MS = 1500;
const AUTO_CONNECT_MAX_DELAY_MS = 30000;

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

// ── Safe, stage-named diagnostics. NEVER logs tokens, cookies, or secrets ──
// (the bridge already strips credential fields; here we only ever pass booleans,
//  ids, status codes and error messages).
function logStage(stage, info = {}) {
  try { console.info(`[GENZ Access] ${stage}`, info); } catch (_) {}
}

// Maps an internal failing stage to an exact, user-safe message (no secrets).
function stageMessage(stage, err) {
  switch (stage) {
    case 'activation_token_failed':
      return 'Could not authorize secure access (activation). Please refresh the dashboard and sign in again.';
    case 'extension_did_not_respond':
      return 'The extension did not respond in time. Reload the extension, then refresh the dashboard.';
    case 'backend_rejected_extension_token':
      return 'Secure access was rejected. Please refresh the dashboard and try again.';
    case 'extension_not_detected':
      return 'Extension not detected. Reload the extension, then refresh the dashboard.';
    case 'session_bundle_missing':
      return 'Session missing for this tool. Please contact admin.';
    case 'no_active_session':
      return 'No active session assigned for this tool. Please refresh or assign account from admin.';
    case 'tool_domain_invalid':
      return 'This tool has no valid target URL configured. Please contact admin.';
    case 'assignment_not_found':
      return 'This tool is not assigned to your account.';
    case 'tool_access_expired':
    case 'assignment_expired':
      return 'This tool assignment has expired or was revoked by admin.';
    case 'device_blocked':
      return 'Access from this device is blocked. Please contact admin.';
    default:
      return (err && err.message) ? err.message : 'Could not prepare secure access. Please refresh the dashboard and try again.';
  }
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

  const connectExtension = useCallback(async (credentials = {}, options = {}) => {
    if (!bridgeReady && !getBridgeMarker()) throw new Error('Extension not detected');

    // Prevent duplicate activation-token consumption during multiple heartbeats.
    if (connectPromiseRef.current) return connectPromiseRef.current;

    connectPromiseRef.current = (async () => {
      const apiUrl = getBackendOrigin();
      const forceReauth = !!(options?.forceReauth || credentials?.forceReauth);
      let payload = { apiUrl, forceReauth };

      if (credentials?.email && credentials?.password) {
        payload = { ...payload, email: credentials.email, password: credentials.password };
      } else {
        let activation;
        try {
          activation = await api.post('/client/extension/activation-token', {
            deviceId: getWebsiteDeviceId(),
            forceReauth,
          });
        } catch (e) {
          // Stage: backend would not issue an activation token (auth/session problem).
          logStage('activation_token_failed', { status: e?.response?.status });
          const err = new Error('activation_token_failed');
          err.stage = 'activation_token_failed';
          throw err;
        }
        payload = { ...payload, activationToken: activation.data.activationToken };
      }

      setStatus(prev => ({ ...(prev || {}), installed: true, connecting: true, reason: null }));
      logStage('extension_connect:send', { forceReauth, hasActivationToken: !!payload.activationToken });
      let resp;
      try {
        resp = await sendToBridge('GENZ_CONNECT_EXTENSION', payload, 15000);
      } catch (e) {
        // Distinguish "extension never answered" from "backend rejected the token".
        const stage = /did not respond/i.test(e.message || '')
          ? 'extension_did_not_respond'
          : 'backend_rejected_extension_token';
        logStage(stage, { error: e.message });
        const err = new Error(e.message || stage);
        err.stage = stage;
        throw err;
      }

      if (resp.success === false) {
        logStage('backend_rejected_extension_token', { error: resp.error });
        const err = new Error(resp.error || 'Extension connection failed');
        err.stage = 'backend_rejected_extension_token';
        throw err;
      }

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

  // Auto-connect from the client dashboard session. Retries forever with
  // exponential backoff while the dashboard tab is open — the UI surfaces the
  // last failure reason and a manual "Retry" button so the user is never stuck
  // staring at a silent spinner.
  useEffect(() => {
    if (!bridgeReady) return;
    autoConnectAttemptsRef.current = 0;
    let cancelled = false;
    let retryTimer = null;

    const attempt = async () => {
      if (cancelled) return;
      const current = await refreshStatus();
      if (current?.connected) {
        autoConnectAttemptsRef.current = 0;
        return;
      }
      const attemptNo = autoConnectAttemptsRef.current + 1;
      autoConnectAttemptsRef.current = attemptNo;
      const forceReauth = attemptNo > AUTO_CONNECT_FORCE_REAUTH_AFTER;
      try {
        await connectExtension({}, { forceReauth });
        await refreshStatus();
        autoConnectAttemptsRef.current = 0;
      } catch (err) {
        if (cancelled) return;
        const stage = err.stage || 'auto_connect_failed';
        logStage('auto_connect:fail', { attempt: attemptNo, stage, error: err.message });
        setStatus(prev => ({
          ...(prev || {}),
          installed: true,
          connected: false,
          connecting: false,
          checking: false,
          reason: stage,
          lastError: err.message || stage,
          attemptCount: attemptNo,
        }));
        // Exponential backoff (1.5s → 3 → 6 → 12 → 24 → cap 30s) — keeps
        // trying as long as the tab is open without flooding the network.
        const delay = Math.min(
          AUTO_CONNECT_INITIAL_DELAY_MS * Math.pow(2, attemptNo - 1),
          AUTO_CONNECT_MAX_DELAY_MS
        );
        retryTimer = setTimeout(attempt, delay);
      }
    };

    attempt();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [bridgeReady, connectExtension, refreshStatus]);

  // User-triggered immediate reconnect — used by the dashboard's Retry button
  // and by the popup's "Reconnect now" path (via GENZ_FORCE_RECONNECT bridge
  // event). Always force-reauths so stale activation-token / device-binding
  // state in the extension storage cannot block recovery.
  const reconnect = useCallback(async () => {
    autoConnectAttemptsRef.current = 0;
    setStatus(prev => ({ ...(prev || {}), connecting: true, reason: null, lastError: null }));
    try {
      await connectExtension({}, { forceReauth: true });
      await refreshStatus();
      return { success: true };
    } catch (err) {
      const stage = err.stage || 'auto_connect_failed';
      setStatus(prev => ({
        ...(prev || {}),
        installed: true,
        connected: false,
        connecting: false,
        checking: false,
        reason: stage,
        lastError: err.message || stage,
      }));
      return { success: false, error: stage, message: stageMessage(stage, err) };
    }
  }, [connectExtension, refreshStatus]);

  // Listen for the popup-triggered "force reconnect" push. The bridge content
  // script forwards the SW message into the page as a window postMessage.
  useEffect(() => {
    const handler = (event) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data?.type === 'GENZ_FORCE_RECONNECT') {
        reconnect().catch(() => {});
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [reconnect]);

  const openTool = useCallback(async (rawToolId, meta = {}) => {
    // Normalize toolId to a string up front (backend + extension compare as string).
    const toolId = (rawToolId === undefined || rawToolId === null) ? '' : String(rawToolId);
    if (!toolId) return { success: false, error: 'tool_domain_invalid', message: stageMessage('tool_domain_invalid') };

    // OceanHub req #1: the Access click sends a proper tool request — toolId, the
    // current Genz backend API URL, the requested tool URL, and the assigned
    // session id. (No secret token here; the extension holds its own session
    // token. These extra fields drive the background's "Processing tool request"
    // log and let it prefer the dashboard-sent URL.)
    const apiBase = getBackendOrigin();
    let domain = meta.domain || null;
    if (!domain && meta.requestedToolUrl) {
      try { domain = new URL(meta.requestedToolUrl).hostname; } catch (_) {}
    }
    const openPayload = {
      toolId,
      forceFreshSession: true,
      apiUrl: apiBase,
      apiBase,
      requestedToolUrl: meta.requestedToolUrl || null,
      toolUrl: meta.requestedToolUrl || null,
      domain,
      login_type: meta.loginType || meta.credentialType || null,
      assignmentId: meta.assignmentId || null,
      sessionId: meta.assignmentId || null,
    };
    if (!bridgeReady && !getBridgeMarker()) {
      return { success: false, error: 'extension_not_detected', message: 'Extension not detected. Reload the extension or refresh the dashboard.' };
    }

    // Ensure a LIVE extension session without tearing down a working one.
    // (A forced reset on every click turned any transient hiccup — a slow
    // service-worker wake, a concurrent auto-connect consuming the single-use
    // activation token, a momentary 401 during cookie refresh — into a hard
    // failure.) Connect only if not already connected; if the stored token is
    // actually stale the post-open retry below reauthenticates once.
    // Freshness of the admin session/cookies is independent of this auth step:
    // credentials are re-fetched per open and old cookies are cleared before
    // the new ones are injected (forceFreshSession below).
    try {
      logStage('ensure_connected:start', { toolId });
      const current = await refreshStatus();
      if (!current?.connected) {
        try {
          await connectExtension();
        } catch (firstErr) {
          // "Secure access was rejected" is almost always stale activation /
          // device-binding state in the extension storage. Re-pair ONCE with a
          // clean slate (forceReauth) before surfacing the error to the user.
          logStage('ensure_connected:retry_force_reauth', { toolId, stage: firstErr.stage || null });
          await connectExtension({}, { forceReauth: true });
        }
        await refreshStatus();
      }
      logStage('ensure_connected:ok', { toolId });
    } catch (err) {
      const stage = err.stage || 'extension_not_connected';
      logStage('ensure_connected:fail', { toolId, stage, error: err.message });
      return { success: false, error: stage, message: stageMessage(stage, err) };
    }

    if (openingRef.current.get(toolId)) return { success: false, error: 'already_opening' };
    openingRef.current.set(toolId, true);

    try {
      // ── OceanHub model ──────────────────────────────────────────────────────
      // No per-click open-intent token. The dashboard simply tells the extension
      // which tool to open; the extension's own session token authorizes the
      // credential/cookie fetch and the background opens the tab via
      // chrome.tabs.create(). Assignment is still enforced server-side at sync
      // time and on every credential fetch, so dropping the intent token does not
      // weaken access control — it just removes the gate that was blocking the
      // tab from ever opening.
      logStage('open_tool:send', { toolId });
      let result = await sendToBridge('GENZ_OPEN_TOOL', openPayload, 20000);
      logStage('open_tool:result', { toolId, success: result?.success !== false, error: result?.error || null, method: result?.method || null });

      // Auto-request missing host permission, then retry. Never tell user to use popup.
      if (result?.error === 'permission_required' && result.originPattern) {
        try {
          const permission = await sendToBridge('GENZ_REQUEST_PERMISSION', { originPattern: result.originPattern }, 20000);
          if (permission?.success || permission?.granted) {
            result = await sendToBridge('GENZ_OPEN_TOOL', openPayload, 20000);
          } else {
            return { success: false, error: 'permission_denied', message: 'Domain access could not be granted automatically. Contact admin.' };
          }
        } catch (_) {
          return { success: false, error: 'permission_denied', message: 'Domain access could not be granted automatically. Contact admin.' };
        }
      }

      // Business stages are FINAL — never reconnect/retry on them. (The auth regex
      // below contains "token", which must not be mistaken for a retryable auth
      // error on an assignment that admin must fix.)
      const BUSINESS_RESULT_STAGES = ['tool_access_expired', 'assignment_expired', 'assignment_not_found', 'device_blocked', 'tool_domain_invalid', 'session_bundle_missing', 'no_active_session'];
      if (result?.error && BUSINESS_RESULT_STAGES.includes(String(result.error))) {
        logStage('business_stage_final', { toolId, stage: result.error });
        return { success: false, error: String(result.error), message: stageMessage(String(result.error), result) };
      }

      // If background signalled auth expiry or needsReauth, silently reconnect
      // ONCE (stale-token retry) and try again.
      if (result?.needsReauth || (result?.error && /auth_expired|token|authorization|401|reauth/i.test(String(result.error)))) {
        logStage('stale_token_retry', { toolId, trigger: result?.error || 'needsReauth' });
        await connectExtension({}, { forceReauth: true });
        result = await sendToBridge('GENZ_OPEN_TOOL', openPayload, 20000);
        logStage('stale_token_retry:result', { toolId, success: result?.success !== false, error: result?.error || null });
      }

      return result;
    } catch (err) {
      const msg = err.message || 'Unknown error';
      logStage('open_tool:throw', { toolId, error: msg, stage: err.stage || null });
      // Known background business stages arrive as Error(code) via the bridge.
      // Map them FIRST and NEVER retry — e.g. 'tool_access_expired' contains
      // "expired" and 'tool_domain_invalid' contains "invalid", which must not be
      // mistaken for a retryable auth error.
      const BUSINESS_STAGES = ['tool_access_expired', 'assignment_expired', 'assignment_not_found', 'device_blocked', 'tool_domain_invalid', 'session_bundle_missing', 'no_active_session'];
      if (BUSINESS_STAGES.includes(msg)) {
        return { success: false, error: msg, message: stageMessage(msg, err) };
      }
      if (/Tool access expired|not assigned|revoked/i.test(msg)) {
        return { success: false, error: 'tool_access_expired', message: stageMessage('tool_access_expired') };
      }
      // Auth/token expiry → reconnect with a FRESH activation token, retry ONCE.
      if (/auth_expired|token|authorization|401|reauth/i.test(msg)) {
        try {
          logStage('stale_token_retry', { toolId, trigger: msg });
          await connectExtension({}, { forceReauth: true });                       // fresh activation token
          const retryResult = await sendToBridge('GENZ_OPEN_TOOL', openPayload, 20000);
          logStage('stale_token_retry:result', { toolId, success: retryResult?.success !== false, error: retryResult?.error || null });
          return retryResult;
        } catch (retryErr) {
          // Surface the EXACT stage that failed during reconnect, not a generic string.
          const rmsg = retryErr.message || '';
          const stage = retryErr.stage || 'extension_reconnect_failed';
          logStage('stale_token_retry:fail', { toolId, stage, error: rmsg });
          return { success: false, error: stage, message: stageMessage(stage, retryErr) };
        }
      }
      return { success: false, error: 'open_failed', message: msg && !/network error|request failed/i.test(msg) ? `Could not open tool: ${msg}` : 'Could not open tool. Please refresh the dashboard and try again.' };
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

  return { status, bridgeReady, openTool, connectExtension, reconnect, grantScanConsent, revokeScanConsent, getScanStatus };
}
