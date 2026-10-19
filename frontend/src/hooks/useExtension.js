/**
 * useExtension.js — robust dashboard ↔ extension communication v3.7
 *
 * The extension is detected through bridge.js heartbeats, not by a fixed Chrome
 * extension ID. If the user loads the unpacked extension while the dashboard is
 * already open, background.js injects bridge.js and this hook auto-pairs using
 * the logged-in client session.
 *
 * There is exactly ONE connection owner per authenticated client lifecycle, shared by every
 * caller — see the comment on `owner` below for why that is a correctness requirement and not an
 * optimisation.
 */

import { useEffect, useSyncExternalStore } from 'react';
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

let _memWebDeviceId = null;
function getWebsiteDeviceId() {
  const mint = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `web_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    let id = localStorage.getItem('device_id');
    if (!id) {
      id = mint();
      localStorage.setItem('device_id', id);
    }
    return id;
  } catch {
    // localStorage blocked (private/incognito, cookies blocked, locked-down browser):
    // never throw — a session-stable in-memory id lets tool access still proceed and
    // surface the REAL backend state instead of crashing the open flow. Mirrors
    // authService.getOrCreateDeviceId().
    if (!_memWebDeviceId) _memWebDeviceId = mint();
    return _memWebDeviceId;
  }
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


// ── ONE CONNECTION OWNER FOR THE WHOLE AUTHENTICATED CLIENT LIFECYCLE ────────────────────────
/**
 * Why this is module state and not hook state.
 *
 * useExtension() is called from four places that can be mounted simultaneously: Zee's
 * ClientGuideProvider (mounted app-wide in the client layout), ClientDashboardEnhanced,
 * ClientToolDetail and ClientActivity. While this state lived in the hook, every mounted caller
 * got its own copy of all of it — its own 500ms bridge poll, its own never-giving-up auto-connect
 * loop with its own backoff, its own in-flight connect promise and its own "already opening" map.
 *
 * Two consequences, both defects rather than mere waste:
 *
 *   - The guard commented "prevent duplicate activation-token consumption during multiple
 *     heartbeats" was a per-instance ref, so it only ever deduplicated within ONE caller. Two
 *     mounted callers minted and consumed two single-use activation tokens concurrently.
 *   - Each caller independently escalated to `forceReauth: true` after three failures, and a
 *     forced re-auth exists precisely to discard stored activation-token / device-binding state.
 *     One owner could therefore tear down the authorization another owner had just established,
 *     leaving the client holding a session that was no longer the authorized one.
 *
 * So there is one owner. Callers subscribe and share its state; the loops start when the first
 * caller mounts and stop shortly after the last one unmounts. That delay is load-bearing: a route
 * change and React's StrictMode double-mount both unmount and immediately remount, and tearing the
 * owner down and rebuilding it on each of those is how competing loops arise in the first place.
 *
 * `gen` is the late-response guard. Every asynchronous continuation captures it before awaiting and
 * drops its result if it no longer matches — so a reply that arrives after a logout or an account
 * switch cannot write stale state over the new client's.
 */
const OWNER_IDLE_GRACE_MS = 2000;

const initialStatus = () => ({ installed: false, connected: false, checking: true });

const owner = {
  status: initialStatus(),
  bridgeReady: false,
  subs: new Set(),
  refs: 0,
  gen: 0,
  connectPromise: null,
  autoAttempts: 0,
  autoRunning: false,
  opening: new Map(),
  wired: false,
  pollTimer: null,
  pollAttempts: 0,
  retryTimer: null,
  stopTimer: null,
};

const emit = () => { for (const fn of [...owner.subs]) { try { fn(); } catch (_) {} } };

const setStatus = (updater) => {
  const next = typeof updater === 'function' ? updater(owner.status) : updater;
  owner.status = next;
  emit();
};

const setBridgeReady = (value) => {
  if (owner.bridgeReady === value) return;
  owner.bridgeReady = value;
  emit();
  if (value) startAutoConnect();
};

// True while `g` is still the current lifecycle. Checked after every await before touching state.
const fresh = (g) => g === owner.gen;

async function refreshStatus() {
  const g = owner.gen;
  try {
    const resp = await sendToBridge('GENZ_GET_EXTENSION_STATUS', {}, 5000);
    if (!fresh(g)) return owner.status;
    setBridgeReady(true);
    const next = {
      installed: true,
      connected: !!resp.connected,
      checking: false,
      version: resp.version,
      toolCount: resp.toolCount || 0,
      lastSync: resp.lastSync || null,
      extensionUpdate: resp.extensionUpdate || null,
      reason: resp.connected ? null : (resp.reason || 'not_connected'),
    };
    setStatus(next);
    return next;
  } catch (err) {
    if (!fresh(g)) return owner.status;
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
}

async function connectExtension(credentials = {}, options = {}) {
  if (!owner.bridgeReady && !getBridgeMarker()) throw new Error('Extension not detected');

  // One single-use activation token at a time, across EVERY caller — this is the whole point of
  // the shared owner. A second concurrent connect returns the first one's promise instead of
  // minting a token that would invalidate it.
  if (owner.connectPromise) return owner.connectPromise;

  const g = owner.gen;
  owner.connectPromise = (async () => {
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

    if (fresh(g)) setStatus(prev => ({ ...(prev || {}), installed: true, connecting: true, reason: null }));
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

    if (fresh(g)) {
      setBridgeReady(true);
      setStatus({
        installed: true,
        connected: true,
        connecting: false,
        checking: false,
        version: resp.version,
        toolCount: resp.toolCount || 0,
        lastSync: resp.lastSync || new Date().toISOString(),
        reason: null,
      });
    }
    return resp;
  })();

  try {
    return await owner.connectPromise;
  } finally {
    owner.connectPromise = null;
  }
}

async function reconnect() {
  const g = owner.gen;
  owner.autoAttempts = 0;
  setStatus(prev => ({ ...(prev || {}), connecting: true, reason: null, lastError: null }));
  try {
    await connectExtension({}, { forceReauth: true });
    await refreshStatus();
    return { success: true };
  } catch (err) {
    const stage = err.stage || 'auto_connect_failed';
    if (fresh(g)) {
      setStatus(prev => ({
        ...(prev || {}),
        installed: true,
        connected: false,
        connecting: false,
        checking: false,
        reason: stage,
        lastError: err.message || stage,
      }));
    }
    return { success: false, error: stage, message: stageMessage(stage, err) };
  }
}

// ── the owner's own listeners and loops ──────────────────────────────────────────────────────
const markReady = () => { setBridgeReady(true); refreshStatus(); };

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
  if (data.type === 'GENZ_EXTENSION_UPDATE') {
    setStatus(prev => ({ ...(prev || {}), extensionUpdate: data.update || null }));
  }
  // The popup's "Reconnect now" arrives as a page message forwarded by the bridge. One owner means
  // one reconnect, not one per mounted caller.
  if (data.type === 'GENZ_FORCE_RECONNECT') {
    reconnect().catch(() => {});
  }
};

// Auto-connect while the tab is open, with exponential backoff. Exactly one of these runs.
function startAutoConnect() {
  if (owner.autoRunning || !owner.bridgeReady || !owner.wired) return;
  owner.autoRunning = true;
  owner.autoAttempts = 0;
  const g = owner.gen;

  const attempt = async () => {
    if (!fresh(g) || !owner.autoRunning) return;
    const current = await refreshStatus();
    if (!fresh(g) || !owner.autoRunning) return;
    if (current?.connected) { owner.autoAttempts = 0; return; }
    const attemptNo = owner.autoAttempts + 1;
    owner.autoAttempts = attemptNo;
    const forceReauth = attemptNo > AUTO_CONNECT_FORCE_REAUTH_AFTER;
    try {
      await connectExtension({}, { forceReauth });
      await refreshStatus();
      if (fresh(g)) owner.autoAttempts = 0;
    } catch (err) {
      if (!fresh(g) || !owner.autoRunning) return;
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
      // 1.5s → 3 → 6 → 12 → 24 → cap 30s. Keeps trying while the tab is open without flooding.
      const delay = Math.min(
        AUTO_CONNECT_INITIAL_DELAY_MS * Math.pow(2, attemptNo - 1),
        AUTO_CONNECT_MAX_DELAY_MS
      );
      owner.retryTimer = setTimeout(attempt, delay);
    }
  };

  attempt();
}

function startOwner() {
  if (owner.wired) return;
  owner.wired = true;
  window.addEventListener('message', messageHandler);
  document.addEventListener('GENZ_BRIDGE_READY', markReady);

  refreshStatus();
  owner.pollAttempts = 0;
  // Bridge-readiness probe: supports the extension being loaded after the page opened. Bounded at
  // 60 attempts (30s) exactly as before — but now once in total, not once per mounted caller.
  owner.pollTimer = setInterval(() => {
    owner.pollAttempts += 1;
    if (getBridgeMarker()) setBridgeReady(true);
    refreshStatus();
    if (owner.pollAttempts >= 60) {
      clearInterval(owner.pollTimer);
      owner.pollTimer = null;
    }
  }, 500);

  startAutoConnect();
}

function stopOwner() {
  owner.wired = false;
  owner.autoRunning = false;
  window.removeEventListener('message', messageHandler);
  document.removeEventListener('GENZ_BRIDGE_READY', markReady);
  if (owner.pollTimer) { clearInterval(owner.pollTimer); owner.pollTimer = null; }
  if (owner.retryTimer) { clearTimeout(owner.retryTimer); owner.retryTimer = null; }
}

function acquireOwner() {
  owner.refs += 1;
  if (owner.stopTimer) { clearTimeout(owner.stopTimer); owner.stopTimer = null; }
  if (!owner.wired) startOwner();
}

function releaseOwner() {
  owner.refs = Math.max(0, owner.refs - 1);
  if (owner.refs > 0 || owner.stopTimer) return;
  // Grace period — a route change or a StrictMode remount must not restart the loops.
  owner.stopTimer = setTimeout(() => {
    owner.stopTimer = null;
    if (owner.refs === 0) stopOwner();
  }, OWNER_IDLE_GRACE_MS);
}

/**
 * End the current connection lifecycle: on logout, and on any account switch.
 *
 * Bumping `gen` is what makes in-flight work harmless — a bridge reply or an activation-token
 * response that lands after this call is dropped instead of being written over the next client's
 * state. The status returns to "checking" rather than to a fabricated connected/disconnected value,
 * because after a logout the real state is genuinely not yet known.
 */
export function resetExtensionOwner() {
  owner.gen += 1;
  owner.connectPromise = null;
  owner.autoAttempts = 0;
  owner.autoRunning = false;
  owner.opening.clear();
  if (owner.retryTimer) { clearTimeout(owner.retryTimer); owner.retryTimer = null; }
  owner.bridgeReady = false;
  owner.status = initialStatus();
  emit();
  // Keep serving whoever is still mounted: restart the loops for the new lifecycle.
  if (owner.wired) {
    stopOwner();
    if (owner.refs > 0) startOwner();
  }
}

async function openTool(rawToolId, meta = {}) {
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
  if (!owner.bridgeReady && !getBridgeMarker()) {
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

  // Shared across callers: the dashboard and an open tool-detail view must not both open the
  // same tool because each kept its own map.
  if (owner.opening.get(toolId)) return { success: false, error: 'already_opening' };
  owner.opening.set(toolId, true);

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
    owner.opening.delete(toolId);
  }
}

async function grantScanConsent() {
  if (!owner.bridgeReady && !getBridgeMarker()) throw new Error('Extension not detected');
  return sendToBridge('GENZ_SCAN_CONSENT');
}

async function revokeScanConsent() {
  if (!owner.bridgeReady && !getBridgeMarker()) throw new Error('Extension not detected');
  return sendToBridge('GENZ_REVOKE_SCAN_CONSENT');
}

async function getScanStatus() {
  if (!owner.bridgeReady && !getBridgeMarker()) return { consentGiven: false };
  return sendToBridge('GENZ_GET_SCAN_STATUS');
}

// The subscription is the only per-caller state left. Every returned function is module-scoped and
// therefore stable, which also stops consumers' effects from re-running on each render.
const subscribe = (fn) => { owner.subs.add(fn); return () => owner.subs.delete(fn); };
const getStatusSnapshot = () => owner.status;
const getBridgeSnapshot = () => owner.bridgeReady;

export function useExtension() {
  const status = useSyncExternalStore(subscribe, getStatusSnapshot, getStatusSnapshot);
  const bridgeReady = useSyncExternalStore(subscribe, getBridgeSnapshot, getBridgeSnapshot);

  useEffect(() => {
    acquireOwner();
    return releaseOwner;
  }, []);

  return { status, bridgeReady, openTool, connectExtension, reconnect, grantScanConsent, revokeScanConsent, getScanStatus };
}

/**
 * Test-only hard reset. Distinct from resetExtensionOwner(), which models a real logout and
 * deliberately keeps serving whoever is still mounted; this returns the module to its load state so
 * one test cannot leak an owner into the next. It exists because the owner is module state, and
 * jest.resetModules() cannot be used to isolate it — resetting the registry would hand the test a
 * second copy of React.
 */
export function __resetExtensionOwnerForTest() {
  stopOwner();
  if (owner.stopTimer) { clearTimeout(owner.stopTimer); owner.stopTimer = null; }
  owner.subs.clear();
  owner.refs = 0;
  owner.gen = 0;
  owner.connectPromise = null;
  owner.autoAttempts = 0;
  owner.autoRunning = false;
  owner.opening.clear();
  owner.bridgeReady = false;
  owner.status = initialStatus();
  owner.pollAttempts = 0;
}

// Test-only introspection. Asserting "one poll, one auto-connect loop, one in-flight connect"
// requires seeing the owner; exposing it read-only is cheaper than exporting the internals.
export function __extensionOwnerForTest() {
  return {
    status: owner.status,
    bridgeReady: owner.bridgeReady,
    refs: owner.refs,
    gen: owner.gen,
    wired: owner.wired,
    subs: owner.subs.size,
    autoRunning: owner.autoRunning,
    hasPoll: owner.pollTimer !== null,
    hasRetry: owner.retryTimer !== null,
    hasStopTimer: owner.stopTimer !== null,
    inFlightConnect: owner.connectPromise !== null,
    opening: [...owner.opening.keys()],
  };
}
