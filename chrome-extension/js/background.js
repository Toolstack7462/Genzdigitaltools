/**
 * Background Service Worker for Gen Z Digital Store Extension v2.1
 * 
 * Enhanced with:
 * - Login Orchestrator for unified login flow
 * - Robust retry logic with exponential backoff
 * - MFA detection and user notification
 * - Comprehensive diagnostics without exposing secrets
 * - Debug mode toggle
 */

import { getOrchestrator } from './core/LoginOrchestrator.js';
import { Logger, enableDebugMode, disableDebugMode, isDebugModeEnabled, getLogHistory, exportLogs } from './core/Logger.js';
import { normalizeCredentialResponse } from './api.js';
import { getShieldConfig } from './config/toolConfigs.js';

// Initialize logger
const logger = new Logger('Background');

// Constants
const SYNC_INTERVAL_MINUTES = 15;
const ALARM_NAME = 'genz-sync';
// One-shot backoff retry alarm for a failed sync. Survives service-worker
// restarts (unlike setTimeout). Cleared on the next successful sync.
const SYNC_RETRY_ALARM = 'genz-sync-retry';
const SYNC_RETRY_BASE_MINUTES = 1;   // first retry after ~1 min
const SYNC_RETRY_MAX_MINUTES = 15;   // cap backoff at the normal interval

// Extract SAFE, readable error details for logging — never secrets. Works for
// Error instances, fetch failures, and plain thrown objects/strings so logs
// never show "[object Object]". `step`/`endpoint` name the sync stage.
function describeError(error, ctx = {}) {
  let message = 'Unknown error';
  if (error instanceof Error) message = error.message || error.name || 'Error';
  else if (typeof error === 'string') message = error;
  else if (error && typeof error === 'object') message = error.message || error.error || JSON.stringify(error).slice(0, 300);
  return {
    step: ctx.step || null,
    endpoint: ctx.endpoint || null,
    status: error?.status ?? ctx.status ?? null,
    code: error?.payload?.code || error?.code || null,
    message,
    retry: ctx.retry ?? null,
  };
}

// State
let orchestrator = null;
let isInitialized = false; // FIX7: prevent duplicate initialization
let activeLogins = new Map();
let toolCredentialsCache = new Map();
let domainToolMap = new Map();
// Duplicate open lock: toolId → timestamp; prevents double-open within 3s
let openIntentLock = new Map();
// Prevents overlapping handleOpenTool invocations (OceanHub safe pattern)
let isToolOpening = false;

// ============================================================================
// STORAGE UTILITIES
// ============================================================================

async function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

async function setStorage(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

async function removeStorage(keys) {
  return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
}

const EXTENSION_SESSION_KEYS = [
  'extensionToken',
  'tokenExpiresAt',
  'tools',
  'toolVersions',
  'sessionBundleVersions',
  'lastSync',
  'userEmail',
  'userName'
];

async function clearExtensionAuthSession(reason = 'force_reauth') {
  await removeStorage(EXTENSION_SESSION_KEYS);
  await clearAllSessionCaches(); // drop cached decrypted sessionBundles on logout/reauth
  toolCredentialsCache.clear();
  domainToolMap.clear();
  try {
    chrome.action.setBadgeText({ text: '' });
  } catch (_) {}
  logger.info('Cleared extension auth/session cache', { reason });
}

// ============================================================================
// API UTILITIES
// ============================================================================


// ── Stable device fingerprint (stored in chrome.storage.local) ──────────────
// Purpose: allow the server-side Risk Engine to detect new/unknown devices.
// The fingerprint is hashed before transmission — the raw value stays local.
async function getOrCreateDeviceId() {
  const stored = await getStorage(['_deviceId']);
  if (stored._deviceId) return stored._deviceId;
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2,'0')).join('');
  await setStorage({ _deviceId: id });
  return id;
}

async function digestSha256(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Normalize a stored API base to the ORIGIN only so we never duplicate the
// /api/crm path. Accepts any of:
//   https://api.genzdigitalstore.com
//   https://api.genzdigitalstore.com/
//   https://api.genzdigitalstore.com/api/crm
//   https://api.genzdigitalstore.com/api/crm/extension
function normalizeApiBase(rawUrl) {
  let base = String(rawUrl || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/api\/crm(\/extension)?$/i, '');
  return base.replace(/\/+$/, '');
}

async function apiRequest(endpoint, options = {}) {
  const data = await getStorage(['apiUrl', 'extensionToken']);

  if (!data.apiUrl || !data.extensionToken) {
    throw new Error('Not authenticated');
  }

  // Defensive: an older install may have stored apiUrl WITH /api/crm appended.
  const base = normalizeApiBase(data.apiUrl);
  const url = `${base}/api/crm/extension${endpoint}`;
  const deviceId = await getOrCreateDeviceId();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `ExtToken ${data.extensionToken}`,
    'X-Extension-Version': chrome.runtime.getManifest().version,
    'X-Device-Id-Hash': await digestSha256(deviceId),
    ...options.headers
  };
  
  logger.debug('API Request', { endpoint, method: options.method || 'GET' });

  const response = await fetch(url, { ...options, headers });
  let result = {};
  try {
    result = await response.json();
  } catch (_) {
    result = { error: response.statusText || 'Non-JSON API response' };
  }

  // ── Safe per-request log: HTTP status + success + counts ONLY (never values).
  // For the /credentials endpoint also include login_type (credentials.type),
  // cookies count, and final tool URL — exactly what the PRD requires.
  try {
    const safe = {
      endpoint,
      method: options.method || 'GET',
      status: response.status,
      ok: response.ok,
      success: result?.success === true,
    };
    if (/^\/tools\/[a-f0-9]+\/credentials$/i.test(endpoint)) {
      safe.login_type = result?.credentials?.type || 'none';
      safe.cookies = Array.isArray(result?.sessionBundle?.cookies)
        ? result.sessionBundle.cookies.length
        : (Array.isArray(result?.credentials?.payload) ? result.credentials.payload.length : 0);
      safe.localStorage = result?.sessionBundle?.localStorage
        ? Object.keys(result.sessionBundle.localStorage).length : 0;
      safe.sessionStorage = result?.sessionBundle?.sessionStorage
        ? Object.keys(result.sessionBundle.sessionStorage).length : 0;
      safe.toolUrl = result?.tool?.targetUrl || result?.tool?.loginUrl || null;
      safe.domain = result?.tool?.domain || null;
      safe.credentialVersion = result?.tool?.credentialVersion || null;
      safe.bundleVersion = result?.sessionBundle?.version || null;
    }
    if (!response.ok && result?.code) safe.code = result.code;
    logger.info('[extension/api] fetch', safe);
  } catch (_) {}

  if (response.status === 401) {
    // Only 401 means the extension token itself is invalid. Do not clear the
    // extension session for 403 business errors such as consumed intent, tool
    // not assigned, missing permission, or assignment expiry.
    logger.warn('Extension token rejected by server, clearing session', { status: response.status });
    await clearExtensionAuthSession('token_rejected_401');
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    notifyDashboardTabs({ type: 'GENZ_EXTENSION_DISCONNECTED', reason: 'token_expired' });
    throw new Error(result.error || 'Extension authorization expired');
  }

  if (!response.ok) {
    const err = new Error(result.error || 'Request failed');
    err.status = response.status;
    err.payload = result;
    throw err;
  }

  return result;
}


// ============================================================================
// DASHBOARD NOTIFICATION HELPER
// ============================================================================
async function notifyDashboardTabs(payload) {
  const DASHBOARD_ORIGINS = [
    'https://genzdigitalstore.com',
    'https://app.genzdigitalstore.com',
    'http://localhost:3000',
  ];
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      try {
        const origin = new URL(tab.url).origin;
        if (DASHBOARD_ORIGINS.includes(origin)) {
          chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
        }
      } catch {}
    }
  } catch (err) {
    logger.warn('notifyDashboardTabs error', { error: err.message });
  }
}



// ============================================================================
// DASHBOARD BRIDGE AUTO-INJECTION
// ============================================================================
const GENZ_DASHBOARD_MATCHES = [
  'https://app.genzdigitalstore.com/*',
  'https://genzdigitalstore.com/*',
  'http://localhost:3000/*',
];

async function injectBridgeIntoDashboardTabs(reason = 'manual') {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab?.id || !tab.url) continue;
      let ok = false;
      try {
        const url = new URL(tab.url);
        ok = (
          url.origin === 'https://app.genzdigitalstore.com' ||
          url.origin === 'https://genzdigitalstore.com' ||
          url.origin === 'http://localhost:3000'
        );
      } catch (_) {}
      if (!ok) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['js/bridge.js'],
        });
        logger.debug('Injected dashboard bridge', { tabId: tab.id, reason });
      } catch (err) {
        // Ignore protected pages, inactive frames, or already-closed tabs.
        logger.debug('Bridge injection skipped', { tabId: tab.id, reason, error: err.message });
      }
    }
  } catch (err) {
    logger.warn('injectBridgeIntoDashboardTabs error', { error: err.message });
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initialize() {
  // FIX7: Prevent overlapping initialization (can be called from onInstalled + onStartup)
  if (isInitialized) {
    logger.debug('Already initialized, skipping duplicate init');
    return;
  }
  isInitialized = true;
  logger.info('Initializing Gen Z Digital Store Extension v3.7');
  
  // Initialize orchestrator
  orchestrator = getOrchestrator();
  
  // Keep session-risk scanner active by default
  await setStorage({ scannerEnabled: true });

  // If the user loaded/reloaded the unpacked extension while dashboard tabs
  // are already open, content_scripts are not injected until refresh. Inject
  // bridge.js proactively so auto-connect can start immediately.
  injectBridgeIntoDashboardTabs('initialize').catch(() => {});

  // Load cached data
  await loadCachedData();
  
  // Setup sync alarm
  await setupSyncAlarm();
  
  // Load token configs
  await loadTokenConfigs();

  // Reconcile expired/revoked tool sessions on every service-worker spin-up.
  // This also covers the "extension was disabled then re-enabled" case — the
  // worker re-initialises on enable and immediately syncs + cleans.
  runCleanupSync('init').catch(() => {});

  logger.info('Initialization complete');
}

async function loadCachedData() {
  const data = await getStorage(['tools', 'domainToolMap']);
  
  if (data.tools) {
    // Build domain to tool map
    for (const tool of data.tools) {
      if (tool.domain) {
        domainToolMap.set(tool.domain, tool);
      }
      // Also map by targetUrl hostname
      try {
        const hostname = new URL(tool.targetUrl).hostname;
        domainToolMap.set(hostname, tool);
      } catch (e) {
        // Invalid URL
      }
    }
    logger.debug('Loaded tool mappings', { count: domainToolMap.size });
  }
}

// ============================================================================
// SYNC & UPDATES
// ============================================================================

async function setupSyncAlarm() {
  await chrome.alarms.clear(ALARM_NAME);

  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: SYNC_INTERVAL_MINUTES
  });

  // Faster, dedicated alarm for expired/revoked session cleanup (every 1–5 min).
  await chrome.alarms.clear(CLEANUP_ALARM_NAME);
  chrome.alarms.create(CLEANUP_ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: CLEANUP_INTERVAL_MINUTES
  });

  logger.debug(`Sync alarm every ${SYNC_INTERVAL_MINUTES}m; cleanup alarm every ${CLEANUP_INTERVAL_MINUTES}m`);
}

// ── Extension self-update awareness ─────────────────────────────────────────
// The backend heartbeat (/tools) returns extensionUpdate = { installed, latest,
// minVersion, updateAvailable, updateRequired, downloadPath }. Persist it so the
// popup + dashboard can show the "download latest" prompt (existing link), badge
// the icon, and (once per new version) raise a friendly notification. No secrets.
async function applyExtensionUpdateInfo(update) {
  if (!update || typeof update !== 'object') return;
  try {
    await setStorage({ extensionUpdate: update });
    notifyDashboardTabs({ type: 'GENZ_EXTENSION_UPDATE', update });

    if (update.updateRequired || update.updateAvailable) {
      chrome.action.setBadgeText({ text: '↑' });
      chrome.action.setBadgeBackgroundColor({ color: update.updateRequired ? '#ef4444' : '#f59e0b' });
      // Notify once per newly-seen latest version (avoid repeat spam each sync).
      const seen = await getStorage(['updateNotifiedFor']);
      if (update.latest && seen.updateNotifiedFor !== update.latest) {
        await setStorage({ updateNotifiedFor: update.latest });
        chrome.notifications.create('genz-ext-update-' + update.latest, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: update.updateRequired ? 'Extension update required' : 'Extension update available',
          message: update.updateRequired
            ? 'Your access is paused until you update. Open the dashboard to download the latest version.'
            : 'A newer version is available. Open the dashboard to download the latest version.',
          priority: update.updateRequired ? 2 : 1,
        });
      }
    }
  } catch (err) {
    logger.debug('applyExtensionUpdateInfo failed', { error: err.message });
  }
}

async function checkForUpdates() {
  try {
    const stored = await getStorage(['toolVersions', 'sessionBundleVersions', 'extensionToken']);
    
    if (!stored.extensionToken) {
      logger.debug('Not authenticated, skipping sync');
      return;
    }
    
    const result = await apiRequest('/tools');
    const tools = result.tools || [];
    // Heartbeat self-update check (backend compares installed vs latest release).
    if (result.extensionUpdate) await applyExtensionUpdateInfo(result.extensionUpdate);
    const oldVersions = stored.toolVersions || {};
    const oldBundleVersions = stored.sessionBundleVersions || {};
    
    // Build new versions map
    const newVersions = {};
    const newBundleVersions = {};
    const credentialUpdates = [];
    const sessionBundleUpdates = [];
    
    for (const tool of tools) {
      const toolId = tool.id;
      
      // Track credential versions
      newVersions[toolId] = {
        version: tool.credentialVersion || 1,
        updatedAt: tool.credentialUpdatedAt
      };
      
      // Track session bundle versions
      if (tool.sessionBundle) {
        newBundleVersions[toolId] = {
          version: tool.sessionBundle.version || 1,
          updatedAt: tool.sessionBundle.updatedAt,
          hasCookies: tool.sessionBundle.hasCookies,
          hasLocalStorage: tool.sessionBundle.hasLocalStorage,
          hasSessionStorage: tool.sessionBundle.hasSessionStorage
        };
      }
      
      // Check for credential updates
      const oldVersion = oldVersions[toolId]?.version || oldVersions[toolId] || 0;
      if (newVersions[toolId].version > oldVersion) {
        credentialUpdates.push({ toolId, name: tool.name });
        // Clear cached credentials for updated tools
        toolCredentialsCache.delete(toolId);
      }
      
      // Check for session bundle updates
      const oldBundleVersion = oldBundleVersions[toolId]?.version || 0;
      if (newBundleVersions[toolId]?.version > oldBundleVersion) {
        sessionBundleUpdates.push({ 
          toolId, 
          name: tool.name,
          oldVersion: oldBundleVersion,
          newVersion: newBundleVersions[toolId].version
        });
        logger.info('Session bundle updated by admin', {
          tool: tool.name,
          oldVersion: oldBundleVersion,
          newVersion: newBundleVersions[toolId].version
        });
      }
    }
    
    // Combine all updates
    const totalUpdates = credentialUpdates.length + sessionBundleUpdates.length;
    
    if (totalUpdates > 0) {
      logger.info('Updates available', { 
        credentials: credentialUpdates.length,
        sessionBundles: sessionBundleUpdates.length
      });
      
      // Show badge for updates
      chrome.action.setBadgeText({ text: String(totalUpdates) });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // Green for session updates
      
      // Store updated versions
      await setStorage({ 
        toolVersions: newVersions,
        sessionBundleVersions: newBundleVersions,
        tools: tools // Cache full tool list
      });
      
      // Notify about session bundle updates (important for user)
      if (sessionBundleUpdates.length > 0) {
        const toolNames = sessionBundleUpdates.map(u => u.name).join(', ');
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Session Data Updated',
          message: `Admin updated session data for: ${toolNames}. Changes will apply automatically on next login.`
        });
      }
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
    
    // Update cached tool mappings
    await loadCachedData();

    await setStorage({
      lastSync: new Date().toISOString(),
      syncStatus: 'ok',
      syncRetryCount: 0,
      lastSyncError: null,
    });
    // Successful sync → cancel any pending backoff retry.
    try { await chrome.alarms.clear(SYNC_RETRY_ALARM); } catch (_) {}

    // Reconcile expired/revoked tool sessions alongside the version sync.
    runCleanupSync('version_sync').catch(() => {});

  } catch (error) {
    // ── Safe, readable failure handling. Never throws, never breaks tool
    // access (assigned tools stay cached + usable), never logs secrets. ──
    const prev = await getStorage(['syncRetryCount']);
    const retry = (Number(prev.syncRetryCount) || 0) + 1;
    const info = describeError(error, { step: 'checkForUpdates', endpoint: '/tools', retry });
    const isAuth = info.status === 401 || /token|unauthor|401/i.test(info.message || '');
    const isNetwork = info.status == null && /fetch|network|failed to fetch|load failed|timeout|offline/i.test(info.message || '');

    logger.warn('Sync check failed', info);

    // Friendly status for popup/dashboard — assigned tools remain usable.
    await setStorage({
      syncStatus: isAuth ? 'auth' : (isNetwork ? 'offline' : 'error'),
      syncRetryCount: retry,
      lastSyncError: { message: info.message, status: info.status, code: info.code, at: new Date().toISOString() },
    });

    // Only an auth failure changes the badge; a transient network/backend hiccup
    // must NOT alarm the user or block tool access.
    if (isAuth) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    }

    // Exponential backoff retry (1,2,4,8… capped), via a one-shot alarm that
    // survives a service-worker shutdown. The 15-min periodic alarm is the
    // ultimate fallback if even this is lost.
    const delay = Math.min(SYNC_RETRY_BASE_MINUTES * Math.pow(2, retry - 1), SYNC_RETRY_MAX_MINUTES);
    try {
      await chrome.alarms.clear(SYNC_RETRY_ALARM);
      chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes: delay });
      logger.debug('Scheduled sync retry', { step: 'retry_backoff', retry, delayMinutes: delay });
    } catch (e) {
      logger.debug('Could not schedule sync retry', describeError(e, { step: 'retry_backoff', retry }));
    }
  }
}

// ============================================================================
// AUTO-LOGIN CONTROLLER
// ============================================================================

/**
 * Handle login required notification from content script
 */
async function handleLoginRequired(data, sender) {
  const { hostname, url } = data;
  const tabId = sender.tab?.id;
  
  logger.info('Login required detected', { hostname, tabId });
  
  // Check if we're already processing login for this tab
  if (activeLogins.has(tabId)) {
    logger.debug('Login already in progress for tab', { tabId });
    return;
  }
  
  // Find tool for this domain
  const tool = domainToolMap.get(hostname);
  
  if (!tool) {
    logger.debug('No tool found for domain', { hostname });
    return;
  }
  
  // Mark login as active
  activeLogins.set(tabId, { tool, startTime: Date.now() });
  
  try {
    // Get credentials (normalized — includes folded session bundle)
    const credentialData = await getToolCredentials(tool.id);

    const creds  = credentialData?.credentials;
    const bundle = credentialData?.sessionBundle;
    const hasCreds = !!(creds && creds.type && creds.type !== 'none');
    const hasBundleCookies = !!(bundle?.cookies && bundle.cookies.length);
    const hasBundleStorage = storageHasKeys(bundle?.localStorage) || storageHasKeys(bundle?.sessionStorage);
    const hasBundle = hasBundleCookies || hasBundleStorage;
    const loginType = hasCreds ? creds.type : (hasBundle ? 'session' : 'none');

    logger.info('Login required — resolving session', {
      tool: tool.name, toolId: String(tool.id), login_type: loginType,
      hasCreds, hasBundleCookies, hasBundleStorage,
    });

    // ── Both missing → clear, honest error (req #1). Never silently no-op. ──
    if (!hasCreds && !hasBundle) {
      logger.warn('No active session for tool on login page', { tool: tool.name, toolId: String(tool.id) });
      notifyDashboardTabs({
        type: 'GENZ_TOOL_UPDATED',
        toolId: String(tool.id),
        error: 'no_active_session',
        message: 'No active session assigned for this tool. Please refresh or assign account from admin.',
      });
      return;
    }

    // ── Session-only tool (cookies/storage, no interactive credentials): just
    //    REAPPLY the session to THIS tab and reload — do NOT raise a
    //    "credentials missing" error (req #1, #3). ──
    if (!hasCreds && hasBundle) {
      logger.info('Reapplying session bundle on login page', {
        tool: tool.name, strategy: 'session', cookies: bundle?.cookies?.length || 0,
      });
      const targetUrl = tool.targetUrl || url;
      if (tool.extensionSettings?.clearExistingCookies !== false) {
        await clearCookiesForDomain(targetUrl);
      }
      let cookieResult = { set: 0, failed: 0 };
      if (hasBundleCookies) cookieResult = await injectCookies(targetUrl, bundle.cookies);
      // req #9: a few failed (analytics) cookies must not block as long as some
      // main session cookies applied.
      if (hasBundleCookies && (cookieResult.set || 0) === 0) {
        logger.warn('Session cookies could not be applied on login page', { tool: tool.name, failed: cookieResult.failed || 0 });
        return;
      }
      if (bundle.localStorage) await injectStorage(tabId, 'localStorage', bundle.localStorage).catch(() => {});
      if (bundle.sessionStorage) await injectStorage(tabId, 'sessionStorage', bundle.sessionStorage).catch(() => {});
      logger.info('Session reapplied — reloading tab', { tool: tool.name, set: cookieResult.set || 0, failed: cookieResult.failed || 0 });
      await chrome.tabs.reload(tabId);
      return;
    }

    // ── Interactive credentials (form/sso/token) → orchestrator, with bundle. ──
    const result = await orchestrator.executeLogin(tool, creds, {
      tabId,
      currentUrl: url,
      sessionBundle: bundle,
      toolInfo: credentialData.tool
    });

    logger.info('Auto-login result', {
      tool: tool.name,
      success: result.success,
      method: result.method,
      login_type: loginType,
      sessionBundleApplied: !!bundle
    });

  } catch (error) {
    logger.error('Auto-login failed', { error: error.message });
  } finally {
    // Clear active login
    activeLogins.delete(tabId);
  }
}

/**
 * Get credentials for a tool (with caching).
 * @param {string} toolId
 * @param {{throwOnFailure?: boolean}} opts - when throwOnFailure is set, a
 *   non-business fetch failure (404/500/network) is surfaced as a tagged
 *   'credentials_unavailable' error instead of resolving to null. This lets the
 *   open-tool flow distinguish "admin assigned a session but it couldn't be
 *   fetched" from "this tool genuinely has no session" — so it never opens a
 *   session-required tool logged-out (OceanHub processTool behaviour).
 */
async function getToolCredentials(toolId, opts = {}) {
  // Check metadata cache (safe — no decrypted credentials stored)
  if (toolCredentialsCache.has(toolId)) {
    const cached = toolCredentialsCache.get(toolId);
    if (Date.now() - cached.timestamp < 5 * 60 * 1000) { // 5-min metadata cache
      logger.debug('Cache hit for tool metadata', { toolId });
      // Cache only holds safe metadata — re-fetch full credentials from API
    }
  }

  try {
    logger.debug('Fetching credentials from API', { toolId });
    const result = await apiRequest(`/tools/${toolId}/credentials`);

    // Cache only non-sensitive metadata (for quick lookups, not for credential reuse)
    const metaCache = {
      credentialVersion: result.tool?.credentialVersion || 1,
      domain: result.tool?.domain || null,
      credentialType: result.credentials?.type || null,
      timestamp: Date.now()
    };
    if (result.credentials) {
      toolCredentialsCache.set(toolId, metaCache);
    }

    // Normalize so cookies/storage arriving as top-level fields OR inside a
    // cookies/storage credential payload are unified into sessionBundle — this is
    // what lets a "cookies" tool be applied BEFORE opening (OceanHub processTool)
    // instead of falling through to a logged-out direct_open.
    const norm = normalizeCredentialResponse(result);

    // Return the full shape callers expect
    // Credentials are NOT cached — they are returned once and must be used immediately
    return {
      credentials: norm.credentials,
      sessionBundle: norm.sessionBundle,
      login_type: norm.login_type,
      toolUrl: norm.toolUrl,
      tool: result.tool,
      credentialVersion: result.tool?.credentialVersion,
      domain: result.tool?.domain,
      timestamp: Date.now()
    };
  } catch (error) {
    // Surface EXACT backend business codes (session_bundle_missing,
    // tool_domain_invalid, assignment_expired/not_found, device_blocked,
    // extension_token_invalid) so the caller can report them precisely instead
    // of silently opening a logged-out tab. Network/unknown failures still
    // resolve to null so transient hiccups don't hard-fail direct-open tools.
    const code = error?.payload?.code || null;
    logger.error('Failed to fetch credentials', { toolId, error: error.message, code, status: error?.status || null });
    if (code) {
      const tagged = new Error(code);
      tagged.code = code;
      tagged.status = error.status;
      tagged.payload = error.payload; // preserve safe fields (e.g. latest/minVersion)
      throw tagged;
    }
    // No business code → infrastructure failure (404/500/network/decrypt).
    // When the caller needs to apply a session, surface this so it does NOT
    // fall through to a logged-out direct_open.
    if (opts.throwOnFailure) {
      const tagged = new Error('credentials_unavailable');
      tagged.code = 'credentials_unavailable';
      tagged.status = error?.status || null;
      throw tagged;
    }
    return null;
  }
}

// ============================================================================
// ONE-CLICK LOGIN (from popup)
// ============================================================================

/**
 * Execute one-click login for a tool using the orchestrator
 */
async function executeOneClickLogin(toolId, tool) {
  logger.info('One-click login started', { tool: tool.name, toolId });
  
  try {
    // Get credentials (includes session bundle)
    const credentialData = await getToolCredentials(toolId);
    
    const creds = credentialData?.credentials;
    const bundle = credentialData?.sessionBundle;
    const hasBundle = !!(bundle?.cookies && bundle.cookies.length) || storageHasKeys(bundle?.localStorage) || storageHasKeys(bundle?.sessionStorage);
    const hasCreds = !!(creds && creds.type && creds.type !== 'none');

    if (!credentialData || (!hasCreds && !hasBundle)) {
      const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
      await logToolOpened(toolId);
      return { success: true, method: 'direct_open', tabId: tab.id };
    }
    if (hasBundle && !hasCreds) {
      const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
      await waitForTabLoad(tab.id, 15000);
      if (tool.extensionSettings?.clearExistingCookies) await clearCookiesForDomain(tool.targetUrl);
      if (bundle.cookies) await injectCookies(tool.targetUrl, bundle.cookies);
      if (bundle.localStorage) await injectStorage(tab.id, 'localStorage', bundle.localStorage);
      if (bundle.sessionStorage) await injectStorage(tab.id, 'sessionStorage', bundle.sessionStorage);
      await chrome.tabs.reload(tab.id);
      await logToolOpened(toolId);
      return { success: true, method: 'session_bundle', tabId: tab.id };
    }
    
    // Execute login via orchestrator with session bundle
    const result = await orchestrator.executeLogin(tool, credentialData.credentials, {
      sessionBundle: credentialData.sessionBundle,
      toolInfo: credentialData.tool
    });
    
    // Credentials are scoped to this function call; no explicit clear needed
    // Log tool opened if successful
    if (result.success) {
      await logToolOpened(toolId);
    }
    
    logger.info('One-click login completed', {
      tool: tool.name,
      success: result.success,
      method: result.method,
      requiresManualAction: result.requiresManualAction,
      sessionBundleApplied: !!credentialData.sessionBundle
    });
    
    return result;
    
  } catch (error) {
    logger.error('One-click login error', { error: error.message });
    return { 
      success: false, 
      error: error.message,
      actionableError: 'Login failed unexpectedly. Please try again or contact support.'
    };
  }
}

/**
 * Log tool opened
 */
async function logToolOpened(toolId) {
  try {
    await apiRequest(`/tools/${toolId}/opened`, { method: 'POST' });
    logger.debug('Tool opened logged', { toolId });
  } catch (e) {
    logger.warn('Failed to log tool opened', { error: e.message });
  }
}

// ============================================================================
// COOKIE INJECTION (Direct method for backward compatibility)
// ============================================================================

async function injectCookies(targetUrl, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { success: false, error: 'No cookies provided' };
  }

  // FIX: Pre-flight permission check before attempting chrome.cookies.set().
  // In MV3, cookie access requires a matching host_permission or runtime-granted
  // optional_host_permission. Without it, chrome.cookies.set() silently returns
  // null. Failing early with a clear message is far better than silent null returns.
  const hasPermission = await chrome.permissions.contains({ origins: [getOriginPattern(targetUrl)] });
  if (!hasPermission) {
    logger.warn('Cookie injection blocked — no host permission for URL', { targetUrl });
    return {
      success: false,
      error: 'Permission not granted for this domain',
      actionRequired: 'Host permission missing for this domain.',
      set: 0,
      failed: cookies.length,
      failures: [{ name: '(all)', error: 'Host permission not granted' }]
    };
  }

  const targetDomain = extractDomain(targetUrl);
  const isHttps = targetUrl.startsWith('https');

  let setCount = 0;
  let failedCount = 0;
  const failures = [];

  logger.debug('Injecting cookies', { count: cookies.length, domain: targetDomain });
  
  for (const cookie of cookies) {
    try {
      // Normalize cookie domain
      let cookieDomain = cookie.domain || targetDomain;
      
      // Ensure leading dot for subdomain cookies
      if (cookieDomain && !cookieDomain.startsWith('.') && cookieDomain !== targetDomain) {
        cookieDomain = '.' + cookieDomain;
      }
      
      const secure = cookie.secure === true || (cookie.secure !== false && isHttps);

      // __Host- cookies are host-only. Chrome CAN set them, but only as:
      //   no domain field, path "/", secure true, URL on the exact target host.
      // They're frequently the MAIN session cookie, so handle (don't skip) them.
      const isHostPrefixed = !!(cookie.name && cookie.name.startsWith('__Host-'));

      // Normalize sameSite; treat 'unspecified' as no_restriction (OceanHub pattern)
      let sameSite = (cookie.sameSite || 'lax').toLowerCase();
      if (sameSite === 'no_restriction' || sameSite === 'none' || sameSite === 'unspecified') {
        sameSite = 'no_restriction';
      } else if (sameSite === 'strict') {
        sameSite = 'strict';
      } else {
        sameSite = 'lax';
      }
      
      // SameSite=None requires Secure; __Host- cookies must also be Secure.
      const finalSecure = (sameSite === 'no_restriction' || isHostPrefixed) ? true : secure;

      let cleanDomain = null; // hoisted so the pre-flight check below can use it
      let cookieDetails;
      if (isHostPrefixed) {
        // Host-only: URL on the exact target host, NO domain, path "/".
        cookieDetails = {
          url: `https://${targetDomain}/`,
          name: cookie.name,
          value: cookie.value,
          path: '/',
          secure: true,
          httpOnly: cookie.httpOnly === true,
          sameSite: sameSite,
        };
      } else {
        const protocol = finalSecure ? 'https' : 'http';
        cleanDomain = cookieDomain.startsWith('.') ? cookieDomain.substring(1) : cookieDomain;
        cookieDetails = {
          url: `${protocol}://${cleanDomain}/`,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || '/',
          secure: finalSecure,
          httpOnly: cookie.httpOnly === true,
          sameSite: sameSite,
        };
        // Set domain ONLY for subdomain cookies (host-only cookies omit it).
        if (cookieDomain.startsWith('.')) {
          cookieDetails.domain = cookieDomain;
        }
      }

      // Handle expiration
      if (cookie.expirationDate) {
        cookieDetails.expirationDate = cookie.expirationDate;
      } else if (cookie.expires) {
        const expiresDate = new Date(cookie.expires);
        if (!isNaN(expiresDate.getTime())) {
          cookieDetails.expirationDate = expiresDate.getTime() / 1000;
        }
      } else {
        // Default: 30 days
        cookieDetails.expirationDate = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
      }

      // ── Pre-flight rejection classification (so logs show a precise reason,
      // not just "Cookie set returned null"). NEVER log the cookie value.
      // __Host- cookies legitimately have no domain attribute, so the
      // domain_mismatch check only applies when a domain IS set (non-host cookies).
      let preReason = null;
      if (!cookie.name) preReason = 'missing_name';
      else if (cookie.value === undefined || cookie.value === null) preReason = 'missing_value';
      else if (sameSite === 'no_restriction' && !finalSecure) preReason = 'samesite_none_requires_secure';
      else if (cookie.name.startsWith('__Secure-') && !finalSecure) preReason = 'secure_prefix_requires_secure';
      else if (cookieDetails.expirationDate && cookieDetails.expirationDate * 1000 < Date.now()) preReason = 'already_expired';
      else if (cookieDetails.domain && cleanDomain && !cleanDomain.endsWith(targetDomain) && !targetDomain.endsWith(cleanDomain)) {
        // domain attribute does not match the target host family
        preReason = 'domain_mismatch';
      }
      if (preReason) {
        failedCount++;
        failures.push({ name: cookie.name || '(unnamed)', reason: preReason });
        continue;
      }

      // chrome.runtime.lastError is the MV3 way Chrome reports cookie rejections.
      // Capture it WITHOUT logging the cookie value. OceanHub-style retry: set()
      // can return null when the domain field conflicts with URL/host rules —
      // retry ONCE without the domain before giving up.
      let result = await chrome.cookies.set(cookieDetails);
      let lastErr = chrome.runtime.lastError?.message || null;
      if (!result && cookieDetails.domain) {
        const { domain, ...noDomain } = cookieDetails;
        result = await chrome.cookies.set(noDomain);
        lastErr = chrome.runtime.lastError?.message || lastErr;
      }
      if (result) {
        setCount++;
      } else {
        throw new Error(lastErr || 'Cookie set returned null');
      }
    } catch (error) {
      failedCount++;
      // Classify common Chrome rejection messages into stable reason codes so
      // ops can grep without parsing free-text. Never include the value.
      const msg = String(error.message || '').toLowerCase();
      let reason = 'unknown';
      if (/samesite/.test(msg)) reason = 'samesite_invalid';
      else if (/secure/.test(msg)) reason = 'secure_required';
      else if (/domain/.test(msg)) reason = 'invalid_domain';
      else if (/path/.test(msg))   reason = 'invalid_path';
      else if (/expir/.test(msg))  reason = 'invalid_expiry';
      else if (/url/.test(msg))    reason = 'invalid_url';
      else if (/null/.test(msg))   reason = 'set_returned_null';
      failures.push({ name: cookie.name, reason, error: error.message });
    }
  }
  
  logger.debug('Cookie injection complete', { set: setCount, failed: failedCount });

  // ── Safe per-domain summary log (counts + reason histogram, never values).
  // Helps quickly spot e.g. "10 cookies all rejected with samesite_none_requires_secure".
  if (failedCount > 0) {
    const reasonCounts = {};
    for (const f of failures) {
      const k = f.reason || 'unknown';
      reasonCounts[k] = (reasonCounts[k] || 0) + 1;
    }
    logger.warn('[extension/cookies] inject failures', {
      domain: targetDomain,
      total: cookies.length,
      set: setCount,
      failed: failedCount,
      reasonCounts,
    });
  }
  
  return {
    success: failedCount === 0,
    set: setCount,
    failed: failedCount,
    failures
  };
}

// ============================================================================
// STORAGE INJECTION
// ============================================================================

async function injectStorage(tabId, storageType, data) {
  logger.debug('Injecting storage', { tabId, storageType, keyCount: Object.keys(data).length });
  
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (storageData, type) => {
      const storage = type === 'sessionStorage' ? sessionStorage : localStorage;
      let setCount = 0;
      const errors = [];
      
      for (const [key, value] of Object.entries(storageData)) {
        try {
          const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
          storage.setItem(key, valueStr);
          setCount++;
        } catch (e) {
          errors.push({ key, error: e.message });
        }
      }
      
      return { success: setCount > 0, set: setCount, errors };
    },
    args: [data, storageType]
  }).then(results => results[0]?.result || { success: false });
}

async function clearPageStorageForTab(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const counts = { localStorage: 0, sessionStorage: 0 };
        try { counts.localStorage = localStorage.length; localStorage.clear(); } catch (_) {}
        try { counts.sessionStorage = sessionStorage.length; sessionStorage.clear(); } catch (_) {}
        return { success: true, cleared: counts };
      }
    });
    logger.debug('Cleared page storage before session apply', { tabId, result: result?.[0]?.result });
    return result?.[0]?.result || { success: true };
  } catch (err) {
    logger.warn('clearPageStorageForTab failed', { tabId, error: err.message });
    return { success: false, error: err.message };
  }
}

// ============================================================================
// TOKEN CONFIGURATION
// ============================================================================

let tokenDomains = new Map();

async function loadTokenConfigs() {
  const data = await getStorage(null);
  tokenDomains.clear();
  
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('token_') || key.startsWith('jwt_')) {
      const domain = key.replace(/^(token_|jwt_)/, '');
      tokenDomains.set(domain, value);
    }
  }
  
  logger.debug('Loaded token configs', { count: tokenDomains.size });
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key.startsWith('token_') || key.startsWith('jwt_')) {
        const domain = key.replace(/^(token_|jwt_)/, '');
        if (newValue) {
          tokenDomains.set(domain, newValue);
        } else {
          tokenDomains.delete(domain);
        }
      }
    }
  }
});

// ============================================================================
// UTILITIES
// ============================================================================

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return url;
  }
}

function getOriginPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch (e) {
    return url;
  }
}

// Hostname/origin only — used in safe logs so we never print full URLs that may
// carry query tokens.
function safeHost(url) {
  try { return new URL(url).hostname; } catch (_) { return null; }
}

// True only when a localStorage/sessionStorage map actually has entries. An empty
// object ({}) must count as NO data — a bare truthy check would wrongly treat it
// as a usable session bundle.
function storageHasKeys(obj) {
  return !!(obj && typeof obj === 'object' && Object.keys(obj).length > 0);
}

// ============================================================================
// FAST-OPEN SESSION CACHE (speed) — never weakens the working session logic.
// Caches the DECRYPTED sessionBundle per tool in chrome.storage.local (sandboxed
// to this extension; not web-accessible). A repeat Access click does a tiny
// version-signature check instead of re-fetching + re-decrypting the whole bundle,
// and skips re-injecting cookies that are verified still present. The signature
// (assignment + credential version + bundle version/updatedAt) invalidates the
// cache automatically the moment admin changes anything. NO secrets are logged.
// ============================================================================
const SESSION_CACHE_PREFIX = 'sessCache_';
const SESSION_APPLY_TTL_MS = 4 * 60 * 1000; // re-inject skipped within this window

// Names that are analytics/tracking → applied AFTER the tab opens so they never
// delay it. Everything else (incl. httpOnly and __Host-/__Secure-) is critical.
const NONCRITICAL_COOKIE_RE = /^(_ga|_gid|_gat|_gcl|__utm|utm_|_fbp|_fbc|_hj|ajs_|amplitude|mp_|mixpanel|intercom|_pk_|_clck|_clsk|optimizely|_uet|_scid|_pin_|_ttp|_rdt)/i;
function isCriticalCookie(c) {
  if (!c || !c.name) return false;
  if (c.httpOnly) return true;                       // httpOnly ⇒ almost always session
  if (/^__(Host|Secure)-/.test(c.name)) return true; // host/secure-prefixed ⇒ session
  if (NONCRITICAL_COOKIE_RE.test(c.name)) return false;
  return true;                                       // default: critical (safe)
}
function classifyCookies(cookies) {
  const critical = [], nonCritical = [];
  for (const c of (cookies || [])) (isCriticalCookie(c) ? critical : nonCritical).push(c);
  return { critical, nonCritical };
}

function sessionCacheKey(toolId) { return `${SESSION_CACHE_PREFIX}${toolId}`; }
async function getSessionCache(toolId) {
  const k = sessionCacheKey(toolId);
  const d = await getStorage([k]);
  return d[k] || null;
}
async function setSessionCache(toolId, data) {
  try { await setStorage({ [sessionCacheKey(toolId)]: data }); } catch (_) {}
}
async function clearAllSessionCaches() {
  try {
    const all = await getStorage(null);
    const keys = Object.keys(all).filter(k => k.startsWith(SESSION_CACHE_PREFIX));
    if (keys.length) await removeStorage(keys);
  } catch (_) {}
}

// One tiny GET (no decrypt) → a version signature for this tool. Returns null on
// any failure so the caller safely falls back to a full fetch.
async function fetchToolVersionSignature(toolId) {
  const res = await apiRequest('/tools/versions');
  const v = (res.versions || {})[String(toolId)];
  if (!v) return null;
  const signature = [
    v.assignmentId || '',
    v.version || '',
    v.bundleVersion || '',
    v.bundleUpdatedAt || '',
  ].join('|');
  return { signature, assignmentId: v.assignmentId || null };
}

function getBaseDomain(hostname) {
  // NOTE: This duplicates DomainUtils.getBaseDomain() in api.js.
  // Both are kept for now since background.js is a service worker module
  // and cannot easily share utilities with popup-scope modules without
  // a dedicated shared utility file. If this list diverges, consolidate
  // into js/utils/domainUtils.js and import from both.
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const commonMultiPartTLDs = ['co.uk', 'com.au', 'co.nz', 'co.in', 'com.br', 'org.uk', 'net.au'];
  const lastTwo = parts.slice(-2).join('.');
  if (commonMultiPartTLDs.includes(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait for a tab to navigate away from a login page.
 * Replaces arbitrary sleep(3000) guesses with event-driven detection.
 * Resolves when tab URL changes to a non-login page, or on timeout.
 */
function waitForTabNavigation(tabId, timeout = 12000) {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve({ success: false, reason: 'timeout' });
    }, timeout);

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      try {
        const pathname = new URL(tab.url || 'https://x.com/').pathname;
        const stillOnLogin = /\/(login|signin|sign-in|auth|sso|saml)/i.test(pathname);
        if (!stillOnLogin) {
          clearTimeout(deadline);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve({ success: true, finalUrl: tab.url });
        }
      } catch (e) { /* non-parseable URL, keep waiting */ }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function waitForTabLoad(tabId, timeout = 30000) {
  // FIX: Event-driven replacement for the 100ms polling loop.
  // The old approach called chrome.tabs.get() up to 300 times per page load.
  return new Promise((resolve) => {
    const deadline = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      try {
        const tab = await chrome.tabs.get(tabId);
        resolve(tab);
      } catch (e) {
        resolve({ id: tabId, status: 'unknown' });
      }
    }, timeout);

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(deadline);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    // Check if tab is already complete before the listener was attached
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.status === 'complete') {
        clearTimeout(deadline);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      }
    });
  });
}


// ============================================================================
// GENZ_OPEN_TOOL — Dashboard-triggered tool open (OceanHub model)
// Flow: Dashboard → bridge.js postMessage → background.js
//       → fetch credentials → open/reuse tab via chrome.tabs.create → run strategy
// ============================================================================

/**
 * Open a tool triggered by the dashboard Access button.
 * OceanHub model: no per-click open-intent token. Assignment is enforced
 * server-side at tool-sync time and on every credential fetch.
 * Steps:
 *  1. (OceanHub) Open directly — no intent-token verification.
 *  2. Duplicate-open lock (3s debounce per toolId).
 *  3. Load tool info from cached tool list.
 *  4. Check host permission; return permission_required if missing.
 *  5. Find or create a tab for the tool.
 *  6. Determine strategy: direct_open / sessionBundle / cookies / form / sso / token.
 *  7. Execute strategy via LoginOrchestrator.
 *  8. Log success to backend.
 */
async function handleOpenTool(payload) {
  // Prevent overlapping invocations (OceanHub isToolOpening pattern)
  if (isToolOpening) {
    return { success: false, error: 'already_opening' };
  }
  isToolOpening = true;
  // Sync assigned-tool status BEFORE opening any tool, so an expired/revoked tool
  // that the user clicks gets its session wiped right away. Fire-and-forget so it
  // never slows the open flow; the credential gate below still enforces access.
  runCleanupSync('before_open').catch(() => {});
  try {
    return await _handleOpenToolInner(payload);
  } finally {
    isToolOpening = false;
  }
}

async function _handleOpenToolInner(payload) {
  const { toolId, forceFreshSession = true } = payload || {};

  // toolId may arrive as a number or string — normalize and compare as string.
  if (toolId === undefined || toolId === null || String(toolId).length === 0) {
    return { success: false, error: 'toolId required' };
  }
  const toolIdStr = String(toolId);

  // ── 1. OceanHub-model open (no per-click open-intent token) ───────────────
  // The dashboard no longer mints a single-use open-intent token per click.
  // Assignment is still fully enforced where it matters:
  //   • the extension only SYNCS tools the client is assigned (GET /extension/tools), and
  //   • the credentials endpoint re-verifies the assignment on every fetch.
  // So we go straight to opening the tab via chrome.tabs.create() in the
  // background, exactly like OceanHub's openToolDirect / processTool actions.

  // ── 2. Duplicate-open lock (3-second debounce) ────────────────────────────
  const now = Date.now();
  if (openIntentLock.has(toolId) && now - openIntentLock.get(toolId) < 3000) {
    logger.debug('Duplicate open suppressed', { toolId });
    return { success: false, error: 'already_opening' };
  }
  openIntentLock.set(toolId, now);
  // Auto-clear lock after 15 seconds
  setTimeout(() => openIntentLock.delete(toolId), 15000);

  // ── 3. Load tool info (compare ids as strings — id may be number or string) ─
  let stored = await getStorage(['tools']);
  let tool = (stored.tools || []).find(t => String(t.id) === toolIdStr);
  if (!tool) {
    logger.info('Tool not found in cache; refreshing tool list', { toolId: toolIdStr });
    await checkForUpdates();
    stored = await getStorage(['tools']);
    tool = (stored.tools || []).find(t => String(t.id) === toolIdStr);
  }
  if (!tool) {
    openIntentLock.delete(toolId);
    return { success: false, error: 'tool_not_synced', message: 'Tool not found. Please refresh the dashboard and try again.' };
  }

  // Normalize the tool target URL from any of the supported field names.
  // Prefer the dashboard-sent requestedToolUrl (OceanHub req #1) but fall back to
  // the synced tool's targetUrl. Either way the URL stays inside the extension.
  const targetUrl = payload?.requestedToolUrl || tool.targetUrl || tool.target_url || tool.url || tool.toolUrl;
  if (!targetUrl) {
    logger.warn('Tool has no valid target URL', { toolId: toolIdStr, stage: 'tool_domain_invalid' });
    openIntentLock.delete(toolId);
    return { success: false, error: 'tool_domain_invalid', stage: 'tool_domain_invalid', message: 'This tool has no valid target URL configured. Please contact admin.' };
  }

  // Does admin require an injected/authorized session for this tool? Derived from
  // the SYNCED tool metadata (never trusts the page). If true, we must apply the
  // session and must NEVER fall back to a logged-out direct_open.
  const toolRequiresSession =
    !!tool.hasCredentials ||
    !!(tool.sessionBundle && (tool.sessionBundle.hasCookies || tool.sessionBundle.hasLocalStorage || tool.sessionBundle.hasSessionStorage));

  // ── OceanHub-style request log (safe metadata only — no secrets) ──────────
  const apiState = await getStorage(['apiUrl']);
  const sessionId = tool.assignment?.id ? String(tool.assignment.id) : (payload?.sessionId ? String(payload.sessionId) : null);
  logger.info('Processing tool request', {
    apiUrl: normalizeApiBase(apiState.apiUrl || payload?.apiUrl || ''),
    toolId: toolIdStr,
    sessionId,
    requestedToolUrl: safeHost(targetUrl),
    requiresSession: toolRequiresSession,
  });

  // ── 4. Check host permission ───────────────────────────────────────────────
  const originPattern = getOriginPattern(targetUrl);
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] })
    .catch(() => false);

  if (tool.extensionSettings?.requirePermission !== false && !hasPermission) {
    logger.warn('Host permission missing for tool', { toolId, targetUrl });
    openIntentLock.delete(toolId);
    return {
      success: false,
      error: 'permission_required',
      domain: tool.domain || new URL(targetUrl).hostname,
      originPattern,
      message: 'Permission required for this tool domain. Requesting access automatically.',
    };
  }

  // ── 5. Resolve the session bundle — FAST PATH (version check + local cache) ─
  // Speed: do a tiny version-signature check instead of always fetching AND
  // decrypting the full bundle. If the signature matches our cached decrypted
  // bundle, reuse it immediately; otherwise fetch fresh. Either way this happens
  // BEFORE the tab opens so cookies apply pre-navigation. Timing is logged below
  // (counts/ms only — never cookie values or secrets).
  const t0 = Date.now();
  let versionCheckMs = 0, fetchMs = 0, injectMs = 0;
  let cacheHit = false, usedCache = false;

  let sigInfo = null;
  const tVc = Date.now();
  try { sigInfo = await fetchToolVersionSignature(toolId); }
  catch (e) { logger.debug('Version check failed; will fetch fresh', { toolId: toolIdStr, error: e.message }); }
  versionCheckMs = Date.now() - tVc;

  let credentialData = null;
  let credFetchStatus = null;
  let credFetchFailed = false;
  let cached = null;

  if (sigInfo) {
    cached = await getSessionCache(toolId);
    if (cached && cached.signature === sigInfo.signature &&
        cached.sessionBundle && Array.isArray(cached.sessionBundle.cookies) && cached.sessionBundle.cookies.length) {
      // CACHE HIT — reuse the decrypted bundle, skip the heavy fetch + decrypt.
      credentialData = { credentials: null, sessionBundle: cached.sessionBundle, tool };
      cacheHit = true;
      usedCache = true;
      logger.info('Session cache HIT', { toolId: toolIdStr, versionCheckMs });
    }
  }

  if (!credentialData) {
    const tF = Date.now();
    try {
      // throwOnFailure: a non-business fetch failure must NOT silently degrade to a
      // logged-out direct_open for a session-required tool.
      credentialData = await getToolCredentials(toolId, { throwOnFailure: true });
    } catch (err) {
      // Exact backend business code (session_bundle_missing, tool_domain_invalid,
      // assignment_expired/not_found, device_blocked, extension_token_invalid) OR
      // 'credentials_unavailable' for an infrastructure failure.
      const code = err?.code || err?.payload?.code || null;
      credFetchStatus = err?.status || null;
      if (code === 'credentials_unavailable' || !code) credFetchFailed = true;
      logger.warn('Credential fetch failed', { toolId: toolIdStr, error: err.message, code, status: credFetchStatus });
      if (code && code !== 'credentials_unavailable') {
        openIntentLock.delete(toolId);
        const FINAL_BUSINESS = ['session_bundle_missing', 'tool_domain_invalid', 'assignment_expired', 'assignment_not_found', 'device_blocked'];
        // Access-revocation codes → immediately reconcile + wipe this tool's
        // session so an already-open tab can't keep being used (req: cleanup on
        // tool open request). runCleanupSync re-fetches the manifest and cleans
        // any tool now revoked/expired/removed, including this one.
        if (['assignment_expired', 'assignment_not_found', 'device_blocked'].includes(code)) {
          runCleanupSync('open_denied').catch(() => {});
        }
        if (FINAL_BUSINESS.includes(code)) {
          // Map ONLY a genuine expiry to the dashboard's tool_access_expired stage
          // (final, non-retry). assignment_not_found must stay DISTINCT so the
          // dashboard shows "Tool not assigned" — never the false "Access expired"
          // for a tool that simply has no assignment row (req #8/#9). All other
          // business codes pass through verbatim.
          const stage = (code === 'assignment_expired') ? 'tool_access_expired' : code;
          return { success: false, error: stage, stage, code };
        }
        if (code === 'extension_token_invalid') {
          return { success: false, error: 'auth_expired', needsReauth: true, code, message: 'Refreshing secure access. Please wait...' };
        }
        if (code === 'extension_update_required') {
          // Below the admin-required minimum version → block opening, surface the
          // update prompt (existing download link via the stored update info).
          const upd = err?.payload || {};
          await applyExtensionUpdateInfo({
            installed: chrome.runtime.getManifest().version,
            latest: upd.latest || null,
            minVersion: upd.minVersion || null,
            updateAvailable: true,
            updateRequired: true,
            downloadPath: upd.downloadPath || '/downloads/genz-digital-store-extension.zip',
          });
          return { success: false, error: 'extension_update_required', stage: 'extension_update_required', code, latest: upd.latest || null, minVersion: upd.minVersion || null, message: 'Please update the extension to the latest version to continue.' };
        }
      }
      // 'credentials_unavailable' falls through with credentialData=null; handled
      // by the session-required guard below.
    }
    fetchMs = Date.now() - tF;
    logger.info('Session cache MISS — fetched fresh', { toolId: toolIdStr, versionCheckMs, fetchMs });
  }

  // If credential fetch failed and the extension session was cleared (401),
  // return an auth error so the dashboard can reconnect instead of silently
  // opening the tab without any session data.
  if (!credentialData) {
    const tokenCheck = await getStorage(['extensionToken']);
    if (!tokenCheck.extensionToken) {
      openIntentLock.delete(toolId);
      return { success: false, error: 'auth_expired', needsReauth: true, message: 'Refreshing secure access. Please wait...' };
    }
  }

  // ── Session-required guard (OceanHub req #3, #4, #5, #10) ──────────────────
  // Admin assigned a session/account for this tool but we have NO usable session
  // data. Do NOT open the tool logged-out via direct_open. We block when EITHER
  // the synced metadata says the tool needs a session, OR the credential fetch
  // actually failed (covers the case where /extension/tools metadata is missing
  // hasCredentials/sessionBundle.hasCookies — a fetch failure on a managed tool
  // must never silently degrade to direct_open, req #5).
  if (!credentialData && (toolRequiresSession || credFetchFailed)) {
    openIntentLock.delete(toolId);
    logger.warn('No authorized session available for session tool', {
      toolId: toolIdStr, sessionId, status: credFetchStatus,
      requiresSession: toolRequiresSession, fetchFailed: credFetchFailed,
    });
    return {
      success: false,
      error: 'no_active_session',
      stage: 'no_active_session',
      status: credFetchStatus,
      message: 'No active session assigned for this tool. Please refresh or assign account from admin.',
    };
  }

  const creds            = credentialData?.credentials;
  const bundle           = credentialData?.sessionBundle;
  const credType         = creds?.type || 'none';
  const hasBundleCookies = !!(bundle?.cookies && bundle.cookies.length);
  const hasBundleStorage = !!(bundle?.localStorage || bundle?.sessionStorage);
  const hasBundle        = hasBundleCookies || hasBundleStorage;
  const hasCreds         = !!(creds && credType !== 'none');
  const willApplyAuth    = hasCreds || hasBundle;

  // Safe debug: latest admin session-bundle composition — COUNTS ONLY, never
  // cookie values, tokens, or any secret.
  let cookieDomain = tool.domain || '';
  try { cookieDomain = new URL(targetUrl).hostname; } catch (_) {}
  const bundleDebug = {
    stage: 'session_bundle',
    domain: cookieDomain,
    cookies: bundle?.cookies?.length || 0,
    localStorage: bundle?.localStorage ? Object.keys(bundle.localStorage).length : 0,
    sessionStorage: bundle?.sessionStorage ? Object.keys(bundle.sessionStorage).length : 0,
    version: bundle?.version || null,
  };
  logger.info('Opening tool', { toolId: toolIdStr, login_type: credType, sessionId, hasBundleCookies, hasBundleStorage, hasCreds });
  logger.info('Latest session bundle received', { toolId: toolIdStr, ...bundleDebug });

  // Admin configured a session for this tool (sync metadata says hasCookies),
  // but the decrypted bundle came back empty → session_bundle_missing.
  if (tool.sessionBundle?.hasCookies && bundleDebug.cookies === 0 && !hasBundleStorage && !hasCreds) {
    logger.warn('Expected session bundle missing', { toolId: toolIdStr, stage: 'session_bundle_missing', domain: cookieDomain });
    openIntentLock.delete(toolId);
    return { success: false, error: 'session_bundle_missing', stage: 'session_bundle_missing', message: 'The latest session for this tool is not available yet. Please contact admin.' };
  }

  // ── 6. Apply cookies BEFORE navigation — speed-optimized ───────────────────
  // Fast path: if the SAME session was applied very recently AND a critical cookie
  // is still in the store, skip clear+reinject entirely and just open (verified
  // via cookies.get, not assumed). Otherwise inject CRITICAL (auth/session)
  // cookies first so the tab opens immediately, and DEFER tracking cookies so they
  // never delay opening (req #7, #9). A direct_open tool is never cleared/logged out.
  let preInjectedCookies = false;
  let skipReinject = false;

  if (hasBundleCookies) {
    const tInj = Date.now();
    const { critical, nonCritical } = classifyCookies(bundle.cookies);
    const criticalSet = critical.length ? critical : bundle.cookies; // never block on tracking-only

    if (usedCache && cached && (Date.now() - (cached.appliedAt || 0) < SESSION_APPLY_TTL_MS)) {
      const probe = criticalSet[0];
      let stillValid = false;
      if (probe?.name) {
        try { stillValid = !!(await chrome.cookies.get({ url: targetUrl, name: probe.name })); } catch (_) {}
      }
      if (stillValid) {
        skipReinject = true;
        preInjectedCookies = true;
        logger.info('Cookies still valid — skipping re-inject', { toolId: toolIdStr, domain: cookieDomain });
      }
    }

    if (!skipReinject) {
      if (forceFreshSession && willApplyAuth) {
        await clearCookiesForDomain(targetUrl);
        logger.info('Cleared old cookies for domain', { toolId: toolIdStr, stage: 'clear_cookies', domain: cookieDomain });
      } else if (tool.extensionSettings?.clearExistingCookies) {
        await clearCookiesForDomain(targetUrl);
      }
      let ck = null;
      try { ck = await injectCookies(targetUrl, criticalSet); }
      catch (err) { logger.warn('Cookie injection threw', { toolId: toolIdStr, stage: 'inject_cookies', domain: cookieDomain, error: err.message }); }
      const setCount = ck?.set || 0;
      const failedCount = ck?.failed || 0;
      preInjectedCookies = setCount > 0;
      // Safe debug: set/failed counts + domain + stage (no cookie values).
      logger.info('Cookie injection result', { toolId: toolIdStr, stage: 'inject_cookies', domain: cookieDomain, set: setCount, failed: failedCount, critical: criticalSet.length });
      // req #9: only the CRITICAL/auth cookies gate login. If NONE of them applied,
      // refuse a logged-out open; failed tracking cookies never block.
      if (setCount === 0) {
        logger.warn('All session cookies failed to apply — refusing logged-out open', { toolId: toolIdStr, domain: cookieDomain, failed: failedCount });
        openIntentLock.delete(toolId);
        return {
          success: false,
          error: 'no_active_session',
          stage: 'inject_cookies',
          domain: cookieDomain,
          set: 0,
          failed: failedCount,
          message: 'No active session assigned for this tool. Please refresh or assign account from admin.',
        };
      }
      // Defer NON-critical (tracking) cookies — fire-and-forget; never delays open.
      if (critical.length && nonCritical.length) {
        injectCookies(targetUrl, nonCritical)
          .then(r => logger.debug('Deferred tracking cookies applied', { toolId: toolIdStr, set: r?.set || 0 }))
          .catch(() => {});
      }
    }
    injectMs = Date.now() - tInj;
  } else if (forceFreshSession && willApplyAuth) {
    // Creds-only path (no bundle cookies) — keep the prior fresh-session clear.
    await clearCookiesForDomain(targetUrl);
    logger.info('Cleared old cookies for domain', { toolId: toolIdStr, stage: 'clear_cookies', domain: cookieDomain });
  }

  // ── 7. NOW open (or reuse) the target tab — it loads with the new session ──
  let targetTabId = null;
  let reuseExisting = false;
  try {
    const toolHostname = new URL(targetUrl).hostname;
    const existingTabs = await chrome.tabs.query({ url: `*://${toolHostname}/*` });
    if (existingTabs.length > 0) {
      targetTabId = existingTabs[0].id;
      reuseExisting = true;
      await chrome.tabs.update(targetTabId, { active: true });
      await chrome.windows.update(existingTabs[0].windowId, { focused: true });
      logger.debug('Reusing existing tab', { tabId: targetTabId, toolId });
    }
  } catch {}

  if (!targetTabId) {
    const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
    targetTabId = newTab.id;
    logger.debug('Opened new tab with fresh session', { tabId: targetTabId, toolId });
  }

  // ── 8. Determine and execute strategy ─────────────────────────────────────
  // direct_open: no credentials and no session bundle. OceanHub req #3/#4: a tool
  // that admin configured WITH a session must never silently direct_open.
  if (!hasCreds && !hasBundle) {
    if (toolRequiresSession) {
      logger.warn('Session-required tool resolved to no session — refusing direct_open', { toolId: toolIdStr, sessionId, login_type: 'none' });
      openIntentLock.delete(toolId);
      return {
        success: false,
        error: 'no_active_session',
        stage: 'no_active_session',
        message: 'No active session assigned for this tool. Please refresh or assign account from admin.',
      };
    }
    logger.info('Strategy: direct_open', { toolId, login_type: 'direct' });
    await logToolOpened(toolId);
    logger.info('Open timing', {
      toolId: toolIdStr, method: 'direct_open',
      cache: cacheHit ? 'hit' : 'miss', skipReinject,
      versionCheckMs, fetchMs, injectMs, totalMs: Date.now() - t0,
    });
    openIntentLock.delete(toolId);
    return { success: true, method: 'direct_open', tabId: targetTabId };
  }

  // sessionBundle only (no form/token credentials). Cookies are already applied
  // pre-navigation; here we only apply page-scoped storage (which needs the tab).
  if (hasBundle && !hasCreds) {
    logger.info('Strategy: sessionBundle_only', { toolId });
    try {
      if (hasBundleStorage) {
        await waitForTabLoad(targetTabId, 15000);
        if (forceFreshSession) await clearPageStorageForTab(targetTabId);
        if (bundle.localStorage) await injectStorage(targetTabId, 'localStorage', bundle.localStorage);
        if (bundle.sessionStorage) await injectStorage(targetTabId, 'sessionStorage', bundle.sessionStorage);
        await chrome.tabs.reload(targetTabId);
      } else if (reuseExisting && preInjectedCookies) {
        // Existing tab already on the domain — reload so the new cookies apply.
        await chrome.tabs.reload(targetTabId);
      }
      await logToolOpened(toolId);
    } catch (err) {
      logger.warn('SessionBundle apply failed', { error: err.message });
      openIntentLock.delete(toolId);
      return { success: false, error: err.message, actionableError: 'Session data could not be applied. Please contact admin.' };
    }
    // Refresh the fast-open cache: store the decrypted bundle + the version
    // signature we validated against + when it was applied. Only when we have a
    // signature (so it can be invalidated later). No secrets are logged.
    if (sigInfo?.signature) {
      await setSessionCache(toolId, {
        signature: sigInfo.signature,
        sessionBundle: bundle,
        domain: cookieDomain,
        appliedAt: Date.now(),
      });
    }
    logger.info('Open timing', {
      toolId: toolIdStr, method: 'session_bundle',
      cache: cacheHit ? 'hit' : 'miss', skipReinject,
      versionCheckMs, fetchMs, injectMs, totalMs: Date.now() - t0,
    });
    openIntentLock.delete(toolId);
    return { success: true, method: 'session_bundle', tabId: targetTabId };
  }

  // Full strategy execution via orchestrator (form/sso/token). Any bundle
  // cookies were already injected pre-navigation; the orchestrator drives login.
  try {
    await waitForTabLoad(targetTabId, 20000);
    // Only wipe the tool page's storage when we actually have replacement storage
    // to inject — otherwise we'd blank a working session and leave nothing (req #7).
    if (forceFreshSession && hasBundleStorage) {
      await clearPageStorageForTab(targetTabId);
    }
    const result = await orchestrator.executeLogin(tool, creds, {
      tabId: targetTabId,
      sessionBundle: bundle,
      toolInfo: credentialData?.tool,
    });

    if (result.success) {
      await logToolOpened(toolId);
    }

    // Surface actionable messages for known failure modes
    if (!result.success && !result.actionableError) {
      if (result.requiresManualAction) {
        result.actionableError = 'MFA, CAPTCHA, or Cloudflare challenge detected. Complete it manually in the browser tab.';
      } else if (result.error?.toLowerCase().includes('permission')) {
        result.actionableError = 'Domain access required. Please try again or contact admin.';
      }
    }

    logger.info('Open timing', {
      toolId: toolIdStr, method: result.method || 'orchestrator',
      cache: cacheHit ? 'hit' : 'miss', skipReinject,
      versionCheckMs, fetchMs, injectMs, totalMs: Date.now() - t0,
    });
    openIntentLock.delete(toolId);
    // Return only safe fields — no credentials
    return {
      success: result.success,
      method: result.method,
      requiresManualAction: result.requiresManualAction || false,
      actionableError: result.actionableError || null,
      tabId: targetTabId,
    };
  } catch (err) {
    logger.error('Strategy execution failed', { error: err.message });
    openIntentLock.delete(toolId);
    return { success: false, error: err.message };
  }
}

/**
 * Clear all cookies for a given URL's domain.
 * Used when clearExistingCookies is enabled before injecting a fresh session.
 */
async function clearCookiesForDomain(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname;
    const allCookies = await chrome.cookies.getAll({ domain: hostname });
    await Promise.allSettled(
      allCookies.map(cookie =>
        chrome.cookies.remove({
          url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
          name: cookie.name,
        })
      )
    );
    logger.debug('Cleared existing cookies', { domain: hostname, count: allCookies.length });
  } catch (err) {
    logger.warn('clearCookiesForDomain failed', { error: err.message });
  }
}


// ============================================================================
// EXPIRED / REVOKED TOOL — AUTOMATIC BROWSER SESSION CLEANUP
// ============================================================================
//
// Goal: the moment a client's assignment to a tool expires or is revoked, wipe
// that tool's browser session so an already-logged-in tab can't keep being used.
//
// Source of truth = GET /extension/cleanup-manifest (active[] + revoked[]). The
// extension ALSO keeps a local registry of every tool it has seen active, so a
// tool that simply disappears from `active` (assignment deleted / no longer
// synced) is still cleaned even though the backend can't enumerate it.
//
// Scope is strictly per-tool (cookieDomains / localStorageOrigins /
// tabUrlPatterns derived server-side from the tool's own domain). It NEVER
// touches unrelated tools, personal sites, or the Gen Z dashboard. No cookies,
// tokens, sessions, or secrets are ever logged — counts and hostnames only.
// ============================================================================

const CLEANUP_ALARM_NAME = 'genz-cleanup';
const CLEANUP_INTERVAL_MINUTES = 2;          // periodic alarm (req: every 1–5 min)
const KNOWN_TOOLS_KEY = 'cleanupKnownTools'; // { [toolId]: { cleanup, access_mode, expiry_date } }
let cleanupInProgress = false;

// Defence-in-depth: never clean our own properties even if a tool is
// misconfigured. The server config builder already excludes these.
const PROTECTED_HOST_RE = /(^|\.)genzdigitalstore\.com$/i;

function isProtectedHost(host) {
  return !!host && PROTECTED_HOST_RE.test(String(host));
}

async function getKnownTools() {
  const d = await getStorage([KNOWN_TOOLS_KEY]);
  return (d && d[KNOWN_TOOLS_KEY]) || {};
}
async function setKnownTools(map) {
  await setStorage({ [KNOWN_TOOLS_KEY]: map || {} });
}

// Build a cleanupToolSession entry from a stored registry record. Accepts BOTH
// the current shape ({cleanup, access_mode, expiry_date}) and the older v3.9.0
// flat shape (the cleanup config object itself), so an upgrade never breaks.
function toKnownEntry(toolId, rec, reason) {
  const cleanup = rec && rec.cleanup ? rec.cleanup : rec; // old shape = bare config
  return {
    toolId,
    cleanup,
    tool_code: (cleanup && cleanup.tool_code) || String(toolId),
    status: reason,
    reason,
    access_mode: (rec && rec.access_mode) || null,
    expiry_date: (rec && rec.expiry_date) || null,
    is_expired: reason === 'removed' ? true : null,
  };
}

// Derive the dashboard app origin (https://app.…) from the stored api origin so
// the expired page's "Renew" button points at the right environment.
async function getAppOrigin() {
  try {
    const d = await getStorage(['apiUrl']);
    const base = normalizeApiBase(d.apiUrl || '');
    if (!base) return null;
    return base.replace('://api.', '://app.');
  } catch (_) { return null; }
}

// Remove cookies for every cookie-domain in a tool's cleanup config via
// chrome.cookies.remove. Scoped strictly to the tool's domains. Returns
// { removed, domainsChecked } (no cookie values are ever read or logged).
async function clearCookiesForConfig(cleanup) {
  let removed = 0;
  const domainsChecked = [];
  const domains = [...new Set([...(cleanup?.cookieDomains || []), ...(cleanup?.domains || [])])];
  for (let domain of domains) {
    domain = String(domain || '').replace(/^\./, '').toLowerCase();
    if (!domain || isProtectedHost(domain) || domainsChecked.includes(domain)) continue;
    domainsChecked.push(domain);
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      const results = await Promise.allSettled((cookies || []).map(cookie => {
        const host = cookie.domain.replace(/^\./, '');
        if (isProtectedHost(host)) return Promise.resolve(null);
        return chrome.cookies.remove({
          url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`,
          name: cookie.name,
        });
      }));
      // Count only actually-removed cookies (remove resolves with details, or
      // null when it couldn't remove — e.g. missing host permission).
      removed += results.filter(r => r.status === 'fulfilled' && r.value).length;
    } catch (err) {
      logger.warn('Cleanup cookie clear failed', { domain, error: err.message });
    }
  }
  return { removed, domainsChecked };
}

// Find open tabs for a tool (chrome.tabs.query), clear their localStorage/
// sessionStorage (chrome.scripting), then redirect them to the friendly expired
// page so the live session cannot continue. Returns { redirected, storageCleared }.
async function clearStorageAndRedirectTabs(cleanup, toolName, reason) {
  const patterns = (cleanup?.tabUrlPatterns || []).filter(Boolean);
  if (!patterns.length) return { redirected: 0, storageCleared: false };

  let matched = [];
  try {
    matched = await chrome.tabs.query({ url: patterns });
  } catch (err) {
    logger.warn('Cleanup tab query failed', { error: err.message });
    return { redirected: 0, storageCleared: false };
  }

  const appOrigin = await getAppOrigin();
  // Pass safe identity (email/name) so the expired page can pre-fill the WhatsApp
  // renewal message. These are NOT secrets; never include tokens/cookies/etc.
  const who = await getStorage(['userEmail', 'userName']);
  let expiredUrl = chrome.runtime.getURL('expired.html')
    + `?tool=${encodeURIComponent(toolName || '')}&reason=${encodeURIComponent(reason || 'expired')}`;
  if (appOrigin) expiredUrl += `&app=${encodeURIComponent(appOrigin)}`;
  if (who.userEmail) expiredUrl += `&email=${encodeURIComponent(who.userEmail)}`;
  if (who.userName) expiredUrl += `&name=${encodeURIComponent(who.userName)}`;

  let redirected = 0;
  let storageCleared = false;
  for (const tab of matched) {
    if (!tab.id || !tab.url) continue;
    let host = null;
    try { host = new URL(tab.url).hostname; } catch (_) {}
    if (isProtectedHost(host)) continue;            // never touch dashboard tabs
    if (tab.url.startsWith(chrome.runtime.getURL(''))) continue; // already our page

    // Clear page storage IN the tool origin before navigating away.
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          let n = 0;
          try { n += localStorage.length; localStorage.clear(); } catch (_) {}
          try { n += sessionStorage.length; sessionStorage.clear(); } catch (_) {}
          return n;
        },
      });
      storageCleared = true; // storage clear executed on at least one tool tab
      void res;
    } catch (_) { /* protected/closed tab — ignore */ }

    try {
      await chrome.tabs.update(tab.id, { url: expiredUrl });
      redirected++;
    } catch (err) {
      logger.warn('Cleanup tab redirect failed', { error: err.message });
    }
  }
  return { redirected, storageCleared };
}

// Full per-tool cleanup: cookies + page storage + open tabs + local caches.
// `entry` carries the manifest fields (toolId/cleanup/status/reason/expiry_date)
// so the debug log can report assignment_status + expiry_date precisely.
async function cleanupToolSession(entry) {
  const cleanup = entry && entry.cleanup;
  if (!cleanup) return;
  const toolId = entry.toolId;
  const reason = entry.reason || entry.status || 'expired';
  const toolName = cleanup.name || 'this tool';

  const { removed: cookiesRemoved, domainsChecked } = await clearCookiesForConfig(cleanup);
  const { redirected: tabsClosed, storageCleared } = await clearStorageAndRedirectTabs(cleanup, toolName, reason);

  // Drop any cached decrypted session bundle + domain map entries for this tool.
  try { await removeStorage([sessionCacheKey(toolId)]); } catch (_) {}
  for (const [host, t] of Array.from(domainToolMap.entries())) {
    if (t && String(t.id) === String(toolId)) domainToolMap.delete(host);
  }

  // SAFE debug log — exactly the required fields. NEVER any cookie value, token,
  // session, password, auth header, or secret; only ids/hostnames/counts/flags.
  logger.info('Tool session cleaned', {
    tool_code: entry.tool_code || cleanup.tool_code || String(toolId),
    assignment_status: entry.status || reason,
    expiry_date: entry.expiry_date || entry.endDate || null,
    is_expired: entry.is_expired ?? null,
    access_mode: entry.access_mode || null,
    domains_checked: domainsChecked,
    cookies_removed_count: cookiesRemoved,
    tabs_closed_count: tabsClosed,
    storage_cleared: storageCleared,
  });

  // Friendly notification only when there was an active session to stop (a tool
  // tab was open). The redirected tab itself also shows the expired page.
  if (tabsClosed > 0) {
    const verb =
      reason === 'revoked' ? 'has been revoked'
      : reason === 'removed' || reason === 'tool_removed' ? 'is no longer available'
      : reason === 'blocked' ? 'has been blocked'
      : 'has expired';
    try {
      chrome.notifications.create('genz-expired-' + toolId, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Access ended',
        message: `Your access to ${toolName} ${verb}. Please renew your plan.`,
        priority: 1,
      });
    } catch (_) {}
  }
}

/**
 * Reconcile the local tool registry against the backend cleanup manifest and
 * wipe the session of every tool that is no longer valid.
 *
 * Triggered on: startup, install/update, browser startup, periodic alarm,
 * version sync, service-worker wake (covers extension re-enable), and on a
 * per-tool open denial.
 */
async function runCleanupSync(reason = 'manual') {
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  try {
    const stored = await getStorage(['extensionToken']);
    if (!stored.extensionToken) {
      // Not connected — we can't authorize a manifest fetch. Leave the registry
      // intact; do NOT wipe (the user may just be temporarily disconnected).
      return;
    }

    const known = await getKnownTools();
    let manifest = null;
    try {
      manifest = await apiRequest('/cleanup-manifest');
    } catch (err) {
      const code = err?.payload?.code || null;
      // Account disabled / device blocked → every known tool's access is gone.
      if (err?.status === 403 || code === 'device_blocked') {
        logger.warn('Cleanup manifest blocked — wiping all known tools', { reason, code });
        for (const [toolId, rec] of Object.entries(known)) {
          await cleanupToolSession(toKnownEntry(toolId, rec, 'blocked'));
        }
        await setKnownTools({});
      } else {
        // 401 already cleared the session inside apiRequest; transient errors
        // are retried on the next tick. Never wipe on a transient failure.
        logger.debug('Cleanup manifest fetch failed', { reason, error: err.message });
      }
      return;
    }

    const active = Array.isArray(manifest?.active) ? manifest.active : [];
    const revoked = Array.isArray(manifest?.revoked) ? manifest.revoked : [];
    const activeIds = new Set(active.map(t => String(t.toolId)));

    // 1) Explicitly revoked/expired/removed/blocked tools from the backend.
    for (const entry of revoked) {
      if (activeIds.has(String(entry.toolId))) continue; // a valid row wins
      await cleanupToolSession(entry);
    }

    // 2) Locally-known tools that vanished from `active` and weren't already
    //    handled above (assignment deleted / no longer synced).
    const revokedIds = new Set(revoked.map(t => String(t.toolId)));
    for (const [toolId, rec] of Object.entries(known)) {
      if (activeIds.has(toolId) || revokedIds.has(toolId)) continue;
      await cleanupToolSession(toKnownEntry(toolId, rec, 'removed'));
    }

    // 3) Refresh the registry to exactly the current active set so future syncs
    //    can detect disappearance. Store cleanup config + a little metadata so
    //    a later "removed" cleanup can still log status/expiry/access_mode.
    const nextKnown = {};
    for (const entry of active) {
      if (entry.cleanup) {
        nextKnown[String(entry.toolId)] = {
          cleanup: entry.cleanup,
          access_mode: entry.access_mode || null,
          expiry_date: entry.expiry_date || entry.endDate || null,
        };
      }
    }
    await setKnownTools(nextKnown);

    if (revoked.length || active.length) {
      logger.debug('Cleanup sync complete', { reason, active: active.length, revoked: revoked.length });
    }
  } catch (err) {
    logger.warn('runCleanupSync error', { reason, error: err.message });
  } finally {
    cleanupInProgress = false;
  }
}

// ============================================================================
// PRIVACY-SAFE EXTENSION RISK SCANNER
// ============================================================================
//
// Security purpose: detect installed browser extensions that have permissions
// commonly associated with session/cookie data access (e.g. "cookies", "tabs",
// "<all_urls>"). This helps admins identify potential session-hijacking risk on
// a member's device.
//
// Privacy guarantees:
//   - Active by default for account/session protection.
//   - Requires the Chrome "management" permission declared in manifest.json.
//   - Only sends: extension name, extension ID, permissions summary, risk level.
//   - Never sends: cookie values, browsing history, personal data, tab contents.
//   - Scan results are sent to our own backend only — no third parties.
//   - If published publicly, disclose this clearly in privacy policy/onboarding.
//
// Risk detection logic:
//   HIGH risk: has "cookies" permission AND broad host permissions (<all_urls>).
//   MEDIUM risk: has "cookies" permission OR broad host permissions.
//   LOW risk: has "tabs" or wide host patterns but no cookie access.
//   We do NOT claim a detected extension copied data — we report the risk posture.
// ============================================================================

const RISKY_KEYWORDS = [
  'cookie', 'session', 'export', 'manager', 'editor', 'hijack',
  'steal', 'harvest', 'scraper', 'extractor',
];

// Describe ONE installed extension with safe metadata only. Returns null for our
// own extension. Computes a riskLevel for EVERY extension ('none' when no risk
// indicators), so admin can see the full installed list — not only risky ones.
// NEVER returns cookie values, history, tab content, or any secret.
function describeExtension(ext) {
  if (!ext || ext.id === chrome.runtime.id) return null; // Skip ourselves

  const perms    = ext.permissions || [];
  const hostPerm = (ext.hostPermissions || []).join(' ');
  const hasCookies = perms.includes('cookies');
  const hasAllUrls = hostPerm.includes('<all_urls>') || hostPerm.includes('https://*/*') || hostPerm.includes('http://*/*');
  const hasTabs    = perms.includes('tabs') || perms.includes('activeTab');
  const nameMatch  = RISKY_KEYWORDS.some(k => ext.name?.toLowerCase().includes(k));

  let riskLevel = 'none';
  if (hasCookies && hasAllUrls) {
    riskLevel = 'high';
  } else if (hasCookies || (hasAllUrls && hasTabs)) {
    riskLevel = 'medium';
  } else if (nameMatch) {
    riskLevel = 'medium';
  } else if (hasTabs && hasAllUrls) {
    riskLevel = 'low';
  }

  const permParts = [];
  if (hasCookies) permParts.push('cookies');
  if (hasTabs)    permParts.push('tabs');
  if (hasAllUrls) permParts.push('<all_urls>');

  return {
    extId:              ext.id,
    extName:            ext.name || 'Unknown',
    version:            ext.version || null,
    enabled:            ext.enabled !== false,
    type:               ext.type || 'extension',
    permissionsSummary: permParts.join(', ') || 'standard',
    riskLevel,
  };
}

// Back-compat wrapper: only RISKY extensions (used by the high-risk alert path).
function scoreExtension(ext) {
  const d = describeExtension(ext);
  if (!d || d.riskLevel === 'none') return null;
  return d;
}

async function runExtensionScan() {
  // 1. Scanner is active by default after extension connection.
  // It sends only safe extension metadata, never cookie values or browsing history.
  const stored = await getStorage(['scannerEnabled', 'extensionToken', 'userEmail', 'userName', 'lastSync', 'tools']);
  if (!stored.extensionToken) return;
  if (stored.scannerEnabled === false) {
    await setStorage({ scannerStatus: 'disabled' });
    return;
  }

  const extensionVersion = chrome.runtime.getManifest().version;
  const scannedAt = new Date().toISOString();
  let deviceIdHash = null;
  try { deviceIdHash = await digestSha256(await getOrCreateDeviceId()); } catch (_) {}

  // Common client/report fields (safe metadata only — never secrets).
  const baseReport = {
    clientEmail:      stored.userEmail || null,
    clientName:       stored.userName || null,
    deviceIdHash,
    extensionVersion,
    lastSync:         stored.lastSync || null,
    toolCount:        Array.isArray(stored.tools) ? stored.tools.length : 0,
    scannedAt,
    scannerEnabled:   true,
    userConsentGiven: true,
  };

  // 2. chrome.management required to enumerate installed extensions.
  if (!chrome.management?.getAll) {
    logger.warn('Extension scan — management permission missing');
    await setStorage({ scannerStatus: 'permission_missing', lastScanAt: scannedAt });
    // Still report status so admin can see the device needs an updated extension.
    try {
      await apiRequest('/security-scan', {
        method: 'POST',
        body: JSON.stringify({ ...baseReport, scannerStatus: 'permission_missing', extensions: [], riskyExtensions: [] }),
      });
    } catch (err) {
      logger.warn('Scanner status report failed', { error: err.message });
    }
    return;
  }

  try {
    const allExtensions = await new Promise(res => chrome.management.getAll(res));
    // Full installed list (safe metadata), plus the risky subset for alerting.
    const extensions = allExtensions.map(describeExtension).filter(Boolean);
    const riskyExtensions = extensions.filter(e => e.riskLevel !== 'none');
    const counts = {
      total:  extensions.length,
      risky:  riskyExtensions.length,
      high:   extensions.filter(e => e.riskLevel === 'high').length,
      medium: extensions.filter(e => e.riskLevel === 'medium').length,
      low:    extensions.filter(e => e.riskLevel === 'low').length,
    };

    logger.info('Extension scan complete', { total: counts.total, risky: counts.risky, high: counts.high });

    if (counts.high > 0) {
      chrome.action.setBadgeText({ text: '⚠' });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      chrome.notifications.create('risk-scan-' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Security Notice — Gen Z Digital Store',
        message: `${counts.high} browser extension(s) with broad data access detected on this device. Your admin has been notified. No action needed unless support contacts you.`,
        priority: 1,
      });
    }

    // 3. Report to backend (safe metadata only — no cookie values/tokens/history).
    await apiRequest('/security-scan', {
      method: 'POST',
      body: JSON.stringify({
        ...baseReport,
        scannerStatus: 'enabled',
        extensions,
        riskyExtensions,
        counts,
      }),
    });
    await setStorage({ scannerStatus: 'enabled', lastScanStatus: 'success', lastScanAt: scannedAt });

  } catch (err) {
    logger.warn('Extension scan failed', { error: err.message });
    await setStorage({ scannerStatus: 'enabled', lastScanStatus: 'failed', lastScanAt: scannedAt });
  }
}

/**
 * Enable security scanner. Active by default; this keeps backward compatibility
 * with existing popup/dashboard messages.
 */
async function grantScanConsent() {
  await setStorage({ scannerEnabled: true, scanConsentGivenAt: new Date().toISOString() });
  logger.info('Extension security scanner enabled');
  await runExtensionScan();
}

/**
 * Disable security scanner internally if required by admin/support.
 */
async function revokeScanConsent() {
  await setStorage({ scannerEnabled: false });
  logger.info('Extension security scanner disabled');
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

// Alarm listener
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    logger.debug('Running scheduled sync check');
    checkForUpdates();
    runExtensionScan();
  } else if (alarm.name === CLEANUP_ALARM_NAME) {
    logger.debug('Running scheduled cleanup sync');
    runCleanupSync('alarm');
  } else if (alarm.name === SYNC_RETRY_ALARM) {
    logger.debug('Running sync backoff retry');
    checkForUpdates();
  }
});

// Install/Update listener
chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed/updated', { reason: details.reason });
  initialize();
  runCleanupSync(`onInstalled:${details.reason}`).catch(() => {});
  setTimeout(() => injectBridgeIntoDashboardTabs(`onInstalled:${details.reason}`), 500);
});

// Startup listener
chrome.runtime.onStartup.addListener(() => {
  logger.info('Browser started');
  initialize();
  runCleanupSync('onStartup').catch(() => {});
  setTimeout(() => injectBridgeIntoDashboardTabs('onStartup'), 1000);
});

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.debug('Message received', { type: message.type, from: sender.tab?.id || 'popup' });
  
  // Handle messages from content script
  if (message.source === 'content') {
    switch (message.type) {
      case 'LOGIN_REQUIRED':
        handleLoginRequired(message.data, sender);
        sendResponse({ received: true });
        break;
        
      case 'LOGIN_STATE':
        if (message.hostname) {
          setStorage({ [`loginState_${message.hostname}`]: message.data });
        }
        sendResponse({ received: true });
        break;
        
      case 'LOGIN_CANCELLED':
        // Cancel any active login for this tab
        const tabId = sender.tab?.id;
        if (tabId && activeLogins.has(tabId)) {
          const flow = activeLogins.get(tabId);
          logger.info('Login cancelled by user', { tool: flow.tool?.name, tabId });
          activeLogins.delete(tabId);
          // Cancel in orchestrator if there's an active flow
          if (orchestrator && flow.flowId) {
            orchestrator.cancelFlow(flow.flowId);
          }
        }
        sendResponse({ received: true });
        break;
        
      default:
        sendResponse({ error: 'Unknown content message type' });
    }
    return;
  }
  
  // Handle messages from popup
  switch (message.type) {
    case 'CHECK_UPDATES':
      checkForUpdates().then(() => sendResponse({ success: true }));
      return true;
      
    case 'CLEAR_BADGE':
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ success: true });
      break;
      
    case 'GET_SYNC_STATUS':
      getStorage(['lastSync', 'toolVersions']).then(data => sendResponse(data));
      return true;
      
    case 'ONE_CLICK_LOGIN':
      // Check if options are provided (for hidden mode, auto mode, etc.)
      if (message.options && (message.options.hidden || message.options.auto)) {
        executeOneClickLoginWithOptions(message.toolId, message.tool, message.options)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ success: false, error: error.message }));
      } else {
        executeOneClickLogin(message.toolId, message.tool)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ success: false, error: error.message }));
      }
      return true;
      
    case 'INJECT_COOKIES':
      injectCookies(message.targetUrl, message.cookies)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
      
    case 'INJECT_STORAGE':
      injectStorage(message.tabId, message.storageType, message.data)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
      
    case 'GET_TOOL_FOR_DOMAIN':
      const tool = domainToolMap.get(message.hostname);
      sendResponse({ tool: tool || null });
      break;
      
    case 'REFRESH_DOMAIN_MAP':
      loadCachedData().then(() => sendResponse({ success: true }));
      return true;
      
    case 'GET_STRATEGY_ENGINE_STATUS':
      sendResponse({
        initialized: !!orchestrator,
        activeLogins: Array.from(activeLogins.keys()),
        cachedCredentials: Array.from(toolCredentialsCache.keys())
      });
      break;
      
    // Debug mode controls
    case 'ENABLE_DEBUG_MODE':
      enableDebugMode();
      sendResponse({ success: true, debugMode: true });
      break;
      
    case 'DISABLE_DEBUG_MODE':
      disableDebugMode();
      sendResponse({ success: true, debugMode: false });
      break;
      
    case 'GET_DEBUG_MODE':
      sendResponse({ debugMode: isDebugModeEnabled() });
      break;
      
    case 'GET_LOGS':
      const logs = getLogHistory(message.filter || {});
      sendResponse({ logs });
      break;
      
    case 'EXPORT_LOGS':
      const exported = exportLogs();
      sendResponse({ exported });
      break;
      
    // ── Bridge messages (forwarded from bridge.js content script) ──────────
    case 'GENZ_EXT_PING':
      getStorage(['extensionToken', 'tools', 'lastSync']).then(d => {
        sendResponse({
          success: true,
          installed: true,
          connected: !!d.extensionToken,
          toolCount: (d.tools || []).length,
          lastSync: d.lastSync || null,
          version: chrome.runtime.getManifest().version,
          name: chrome.runtime.getManifest().name,
        });
      });
      return true;

    case 'GENZ_GET_EXTENSION_STATUS':
      getStorage(['extensionToken', 'tokenExpiresAt', 'lastSync', 'tools', 'userEmail', 'extensionUpdate', 'syncStatus']).then(async d => {
        const expired = d.tokenExpiresAt && Date.parse(d.tokenExpiresAt) <= Date.now();
        if (expired) {
          await clearExtensionAuthSession('stored_token_expired');
          sendResponse({
            success: true,
            connected: false,
            reason: 'stored_token_expired',
            toolCount: 0,
            lastSync: null,
            version: chrome.runtime.getManifest().version,
          });
          return;
        }
        const expiresAt = d.tokenExpiresAt ? Date.parse(d.tokenExpiresAt) : null;
        const expiresInDays = expiresAt ? Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)) : null;
        sendResponse({
          success: true,
          connected: !!d.extensionToken,
          reason: d.extensionToken ? null : 'not_connected',
          toolCount: (d.tools || []).length,
          lastSync: d.lastSync || null,
          userEmail: d.userEmail || null,
          tokenExpiresAt: d.tokenExpiresAt || null,
          expiresInDays,
          version: chrome.runtime.getManifest().version,
          extensionUpdate: d.extensionUpdate || null,
          syncStatus: d.syncStatus || null,
        });
      });
      return true;

    case 'GENZ_CONNECT_EXTENSION':
      (async () => {
        const { apiUrl, email, password, activationToken, forceReauth } = message.payload || {};
        if (!apiUrl || (!activationToken && (!email || !password))) {
          sendResponse({ success: false, error: 'apiUrl and activationToken required' });
          return;
        }
        try {
          if (forceReauth) {
            await clearExtensionAuthSession('dashboard_forced_reauth');
          }
          const base = normalizeApiBase(apiUrl);
          const url = activationToken
            ? `${base}/api/crm/extension/auth/activate`
            : `${base}/api/crm/extension/auth`;
          const deviceId = await getOrCreateDeviceId();
          const body = activationToken ? { activationToken } : { email, password };
          const r = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Extension-Version': chrome.runtime.getManifest().version,
              'X-Device-Id-Hash': await digestSha256(deviceId),
            },
            body: JSON.stringify(body),
          });
          const d = await r.json();
          if (!r.ok || !d.token) {
            // Server-side rejection. If the activation flow says the token is
            // invalid/expired/used, also wipe any stale extension session — the
            // next dashboard attempt will start completely clean.
            const code = d.code || '';
            if (r.status === 401 || r.status === 403 || /extension_token_invalid|activation/i.test(code)) {
              await clearExtensionAuthSession('auth_rejected_' + (code || r.status));
            }
            sendResponse({
              success: false,
              error: d.error || 'Authentication failed',
              code: code || null,
              status: r.status,
            });
            return;
          }
          await setStorage({
            extensionToken: d.token,
            apiUrl: base,
            tokenExpiresAt: d.expiresAt,
            userEmail: d.user?.email || null,
            userName: d.user?.name || null
          });
          chrome.action.setBadgeText({ text: '' });
          await checkForUpdates();
          notifyDashboardTabs({
            type: 'GENZ_EXTENSION_CONNECTED',
            connected: true,
            userEmail: d.user?.email || null,
            tokenExpiresAt: d.expiresAt,
            version: chrome.runtime.getManifest().version
          });
          sendResponse({ success: true, user: d.user, version: chrome.runtime.getManifest().version, connected: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;


    case 'GENZ_RESET_EXTENSION_SESSION':
      (async () => {
        try {
          const reason = message.payload?.reason || 'dashboard_reset';
          await clearExtensionAuthSession(reason);
          notifyDashboardTabs({ type: 'GENZ_EXTENSION_DISCONNECTED', reason });
          sendResponse({ success: true, reset: true, reason });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    case 'GENZ_ENABLE_SCANNER_AUTO':
      setStorage({ scannerEnabled: true, scanConsentGivenAt: new Date().toISOString() })
        .then(() => { runExtensionScan(); sendResponse({ success: true, scannerEnabled: true }); })
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'GENZ_SCAN_CONSENT':
      grantScanConsent()
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'GENZ_REVOKE_SCAN_CONSENT':
      revokeScanConsent()
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'GENZ_GET_SCAN_STATUS':
      getStorage(['scanConsentGivenAt', 'scannerEnabled', 'scannerStatus', 'lastScanStatus', 'lastScanAt']).then(d => {
        const managementAvailable = !!(chrome.management && chrome.management.getAll);
        const enabled = d.scannerEnabled !== false;
        // Derive a single status: permission missing > disabled > last scan result.
        let status = 'enabled';
        if (!managementAvailable) status = 'permission_missing';
        else if (!enabled) status = 'disabled';
        else if (d.lastScanStatus === 'failed') status = 'last_scan_failed';
        else if (d.lastScanStatus === 'success') status = 'last_scan_successful';
        sendResponse({
          consentGiven: enabled,
          scannerEnabled: enabled,
          consentDate: d.scanConsentGivenAt || null,
          managementAvailable,
          status,
          lastScanStatus: d.lastScanStatus || null,
          lastScanAt: d.lastScanAt || null,
        });
      });
      return true;

    case 'GENZ_REQUEST_PERMISSION':
      (async () => {
        try {
          const { originPattern } = message.payload || {};
          if (!originPattern || typeof originPattern !== 'string') {
            sendResponse({ success: false, error: 'originPattern required' });
            return;
          }
          const granted = await chrome.permissions.request({ origins: [originPattern] });
          sendResponse({ success: !!granted, granted: !!granted, originPattern });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    case 'GENZ_OPEN_TOOL':
    // OceanHub-style message-name aliases. All three route to the same secure
    // handleOpenTool() flow (intent verification → credential fetch → cookie
    // inject → chrome.tabs.create). The action hint travels in the payload
    // so a future content-script can post `processTool` / `openToolDirect` /
    // `autoLoginNoSave` and get the equivalent behavior.
    case 'GENZ_PROCESS_TOOL':
    case 'GENZ_OPEN_TOOL_DIRECT':
    case 'GENZ_AUTO_LOGIN_NO_SAVE':
      handleOpenTool({
        ...(message.payload || {}),
        actionType: message.type === 'GENZ_OPEN_TOOL_DIRECT' ? 'openToolDirect'
                  : message.type === 'GENZ_AUTO_LOGIN_NO_SAVE' ? 'autoLoginNoSave'
                  : message.type === 'GENZ_PROCESS_TOOL'       ? 'processTool'
                  : (message.payload?.actionType || 'processTool'),
      })
        .then(r => sendResponse(r))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// Tab update listener - detect navigation to tool domains
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    try {
      const urlObj = new URL(tab.url);
      const hostname = urlObj.hostname;
      const tool = domainToolMap.get(hostname);
      
      if (tool) {
        logger.debug('Tab navigated to tool domain', { hostname, tabId });

        // Hide shared-account chrome + guard logout/account routes on every tool-tab
        // load (fire-and-forget; safe on login pages — it never touches inputs/forms).
        injectShield(tabId, tab.url, tool);

        // Check for auto-start and hidden mode params
        const autoParam = urlObj.searchParams.get('auto');
        const hiddenParam = urlObj.searchParams.get('hidden');
        const isAutoMode = autoParam === '1' || autoParam === 'true';
        const isHiddenMode = hiddenParam === '1' || hiddenParam === 'true';
        
        // Check if this is a login page
        const isLoginPage = /\/(login|signin|auth|sso)/i.test(urlObj.pathname) || 
                           urlObj.pathname.includes('login') ||
                           tab.url.includes(tool.loginUrl || '');
        
        logger.debug('Page analysis', { isAutoMode, isHiddenMode, isLoginPage });
        
        // Handle auto-start mode with ?auto=1
        if (isAutoMode && isLoginPage) {
          logger.info('Auto-start mode triggered', { tool: tool.name, hidden: isHiddenMode });
          
          // Check if tool has auto-start enabled
          const autoStartEnabled = tool.extensionSettings?.autoStartEnabled !== false;
          const comboTriggerOnAuto = !tool.comboAuth?.enabled || tool.comboAuth?.triggerOnAuto !== false;
          
          if (autoStartEnabled && comboTriggerOnAuto) {
            // Execute auto-login
            handleAutoStartLogin(tabId, tab, tool, { auto: true, hidden: isHiddenMode });
          }
        } else {
          // Inject content script dynamically for regular flow
          await injectContentScript(tabId, tab.url);
        }
      }
    } catch (e) {
      // Invalid URL or injection failed
      logger.warn('Tab update handler error', { error: e.message });
    }
  }
});

/**
 * Handle auto-start login when ?auto=1 is detected
 * This runs on the EXISTING tab - no need to create a new one
 */
async function handleAutoStartLogin(tabId, tab, tool, options = {}) {
  const { auto, hidden, sourceTabId } = options;
  
  // Check if we're already processing login for this tab
  if (activeLogins.has(tabId)) {
    logger.debug('Login already in progress for tab', { tabId });
    return;
  }
  
  // Mark login as active
  activeLogins.set(tabId, { tool, startTime: Date.now(), autoMode: true });
  
  try {
    // Get credentials from API
    const credentialData = await getToolCredentials(tool.id);

    if (!credentialData || !credentialData.credentials) {
      logger.warn('No credentials for auto-start', { tool: tool.name });
      activeLogins.delete(tabId);
      return;
    }

    // Small delay to let page render
    await sleep(500);

    // Pass only the credentials object (not the full credentialData wrapper)
    const loginResult = await executeAutoLoginOnExistingTab(tabId, tool, credentialData.credentials);
    
    logger.info('Auto-start login result', { 
      tool: tool.name, 
      success: loginResult.success, 
      method: loginResult.method,
      requiresManualAction: loginResult.requiresManualAction
    });
    
    // Log tool opened if successful
    if (loginResult.success) {
      await logToolOpened(tool.id);
    }
    
  } catch (error) {
    logger.error('Auto-start login failed', { error: error.message });
  } finally {
    // Clear active login
    activeLogins.delete(tabId);
  }
}

/**
 * Execute auto-login on an EXISTING tab (user already on login page with ?auto=1)
 * This fills the form and submits it directly - no new tab creation
 */
async function executeAutoLoginOnExistingTab(tabId, tool, credentials) {
  const credType = credentials?.type;
  
  logger.info('Executing auto-login on existing tab', { tabId, credType });
  
  // Inject "Logging in..." overlay
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (toolName) => {
        const existing = document.getElementById('genz-login-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'genz-login-overlay';
        overlay.innerHTML = `
          <div style="
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 999999;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border: 1px solid rgba(255, 140, 0, 0.3);
            border-radius: 12px;
            padding: 16px 24px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            display: flex;
            align-items: center;
            gap: 12px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          ">
            <div style="
              width: 24px;
              height: 24px;
              border: 3px solid rgba(255, 140, 0, 0.3);
              border-top-color: #ff8c00;
              border-radius: 50%;
              animation: genz-spin 1s linear infinite;
            "></div>
            <div>
              <div style="color: white; font-weight: 600; font-size: 14px;">Logging in to ${toolName}...</div>
              <div style="color: rgba(255,255,255,0.6); font-size: 12px; margin-top: 2px;">Please wait</div>
            </div>
            <button id="genz-cancel-login" style="
              margin-left: 16px;
              background: transparent;
              border: 1px solid rgba(255,255,255,0.3);
              color: rgba(255,255,255,0.8);
              padding: 6px 12px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 12px;
            ">Cancel</button>
          </div>
          <style>@keyframes genz-spin { to { transform: rotate(360deg); } }</style>
        `;
        document.body.appendChild(overlay);
      },
      args: [tool.name]
    });
  } catch (e) {
    logger.warn('Failed to inject overlay', { error: e.message });
  }
  
  // Extract credentials for form fill
  let username = null;
  let password = null;
  let multiStep = false;
  let autoSubmit = true;
  
  // Check combo auth first
  if (tool.comboAuth?.enabled && tool.comboAuth?.formConfig) {
    username = tool.comboAuth.formConfig.username;
    password = tool.comboAuth.formConfig.password;
    multiStep = tool.comboAuth.formConfig.multiStep || false;
    autoSubmit = tool.comboAuth.formConfig.autoSubmit !== false;
  } else if (credType === 'form' && credentials.payload) {
    username = credentials.payload.username;
    password = credentials.payload.password; // never logged below
    multiStep = credentials.formOptions?.multiStep || credentials.payload?.multiStep || false;
    autoSubmit = credentials.formOptions?.autoSubmit !== false;
  }
  
  if (!username || !password) {
    removeOverlay(tabId);
    return { success: false, error: 'No form credentials configured' };
  }
  
  // Auto-fill delay
  const autoStartDelay = tool.extensionSettings?.autoStartDelay || 800;
  await sleep(autoStartDelay);
  
  // Execute form fill with auto-submit
  try {
    const fillResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: formFillAndSubmitScript,
      args: [username, password, credentials.selectors || {}, multiStep, autoSubmit]
    });
    
    const result = fillResult[0]?.result;
    
    if (!result?.success) {
      removeOverlay(tabId);
      return { success: false, error: result?.error || 'Form fill failed' };
    }
    
    // FIX: Use event-driven navigation detection instead of arbitrary sleep(3000).
    // waitForTabNavigation listens for tabs.onUpdated and resolves as soon as the
    // tab navigates away from a login URL, or falls back after 12 seconds.
    const navResult = await waitForTabNavigation(tabId, 12000);
    
    // Check for success (navigated away from login page)
    const successCheck = navResult.success
      ? { success: true, currentUrl: navResult.finalUrl }
      : await checkLoginSuccessOnTab(tabId, tool, credentials.successCheck);
    
    removeOverlay(tabId);
    
    if (successCheck.success) {
      return { success: true, method: 'form_auto', finalUrl: successCheck.currentUrl };
    }
    
    // Check for MFA
    const mfaCheck = await checkForMFAOnTab(tabId);
    if (mfaCheck.hasMFA) {
      return { 
        success: false, 
        requiresManualAction: true, 
        manualActionReason: 'MFA/2FA detected - please complete manually',
        tabId 
      };
    }
    
    return { success: false, error: 'Login did not complete successfully' };
    
  } catch (error) {
    removeOverlay(tabId);
    return { success: false, error: error.message };
  }
}

/**
 * Remove login overlay from tab
 */
async function removeOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const overlay = document.getElementById('genz-login-overlay');
        if (overlay) overlay.remove();
      }
    });
  } catch (e) {}
}

/**
 * Form fill and submit script - injected into page
 * Matches SSO auto-click behavior: fills form and auto-submits
 */
function formFillAndSubmitScript(username, password, customSelectors, multiStep, autoSubmit) {
  const result = { success: false, steps: [], error: null, autoSubmitted: false };
  
  // Selector lists
  const usernameSelectors = [
    customSelectors?.username,
    'input[type="email"]', 'input[name="email"]', 'input[id="email"]',
    'input[name="username"]', 'input[id="username"]', 'input[name="login"]',
    'input[autocomplete="email"]', 'input[autocomplete="username"]',
    'input[placeholder*="email" i]', 'input[placeholder*="username" i]',
    'input[name="identifier"]', 'input[name="account"]'
  ].filter(Boolean);

  const passwordSelectors = [
    customSelectors?.password,
    'input[type="password"]', 'input[name="password"]', 'input[id="password"]',
    'input[autocomplete="current-password"]'
  ].filter(Boolean);

  const submitSelectors = [
    customSelectors?.submit,
    'button[type="submit"]', 'input[type="submit"]',
    'button[class*="login" i]', 'button[class*="signin" i]', 'button[class*="submit" i]',
    'button[id*="login" i]', 'button[id*="signin" i]',
    '[role="button"][class*="login" i]', '[role="button"][class*="submit" i]',
    'form button:not([type="button"])'
  ].filter(Boolean);

  const nextButtonSelectors = [
    customSelectors?.next,
    'button[class*="next" i]', 'button[id*="next" i]',
    'button:not([type="submit"])[class*="continue" i]',
    'input[type="button"][value*="next" i]'
  ].filter(Boolean);

  // Helper: Find visible element
  const findElement = (selectorList) => {
    for (const selector of selectorList) {
      if (!selector) continue;
      try {
        const el = document.querySelector(selector);
        if (el && el.offsetParent !== null) return el;
        
        // Check iframes
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            if (iframe.contentDocument) {
              const iframeEl = iframe.contentDocument.querySelector(selector);
              if (iframeEl && iframeEl.offsetParent !== null) return iframeEl;
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
    return null;
  };

  // Helper: Set input value (React/Vue compatible)
  const setInputValue = (input, value) => {
    input.focus();
    input.value = '';
    
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }
    
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  };

  // Helper: Click element
  const clickElement = (el) => {
    el.focus();
    el.click();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };

  // Helper: Submit form properly
  const submitForm = (formOrButton) => {
    const form = formOrButton.closest ? formOrButton.closest('form') : formOrButton;
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit();
        return true;
      } catch (e) {}
    }
    if (formOrButton.click) {
      formOrButton.click();
      return true;
    }
    return false;
  };

  // Helper: Press Enter
  const pressEnter = (el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  };

  // STEP 1: Find and fill username
  const usernameField = findElement(usernameSelectors);
  if (!usernameField) {
    result.error = 'Username field not found';
    return result;
  }

  setInputValue(usernameField, username);
  result.steps.push({ field: 'username', success: true });

  // STEP 2: Check for password field
  const passwordField = findElement(passwordSelectors);

  if (passwordField) {
    // Single-step login: fill password and submit
    setInputValue(passwordField, password);
    result.steps.push({ field: 'password', success: true });

    if (autoSubmit) {
      // Small delay before submit (like SSO auto-click)
      setTimeout(() => {
        const submitBtn = findElement(submitSelectors);
        if (submitBtn) {
          submitForm(submitBtn);
          result.steps.push({ action: 'submit', success: true });
        } else {
          pressEnter(passwordField);
          result.steps.push({ action: 'enter_key', success: true });
        }
        result.autoSubmitted = true;
      }, 300);
    }

    result.success = true;
    result.multiStep = false;

  } else if (multiStep) {
    // Multi-step login: click next, wait, then fill password
    const nextBtn = findElement(nextButtonSelectors) || findElement(submitSelectors);
    
    if (nextBtn) {
      clickElement(nextBtn);
      result.steps.push({ action: 'next_click', success: true });
      result.multiStep = true;

      // Schedule password fill after page transition
      setTimeout(() => {
        const pwdField = findElement(passwordSelectors);
        if (pwdField) {
          setInputValue(pwdField, password);
          
          if (autoSubmit) {
            setTimeout(() => {
              const finalSubmit = findElement(submitSelectors);
              if (finalSubmit) {
                submitForm(finalSubmit);
              } else {
                pressEnter(pwdField);
              }
            }, 300);
          }
        }
      }, 1500);

      result.success = true;
    } else {
      result.error = 'Next/submit button not found for multi-step';
    }
  } else {
    // No password field visible, try pressing Enter on username
    if (autoSubmit) {
      pressEnter(usernameField);
      result.steps.push({ action: 'enter_on_username', success: true });
    }
    result.success = true;
  }

  return result;
}

/**
 * Check login success on tab
 */
async function checkLoginSuccessOnTab(tabId, tool, successCheck) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const currentUrl = tab.url || '';
    
    // Check if navigated away from login page
    const isStillOnLogin = /\/(login|signin|auth)/i.test(currentUrl);
    
    // Check success indicators
    if (successCheck?.urlIncludes && currentUrl.includes(successCheck.urlIncludes)) {
      return { success: true, currentUrl };
    }
    
    if (successCheck?.urlExcludes && currentUrl.includes(successCheck.urlExcludes)) {
      return { success: false, currentUrl };
    }
    
    // If navigated to dashboard/home, consider success
    if (!isStillOnLogin && (currentUrl.includes('dashboard') || currentUrl.includes('home') || currentUrl === tool.targetUrl)) {
      return { success: true, currentUrl };
    }
    
    // Check for logged-in elements
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (elementSelector) => {
        if (elementSelector) {
          const el = document.querySelector(elementSelector);
          if (el && el.offsetParent !== null) return { hasElement: true };
        }
        
        // Check common logged-in indicators
        const indicators = [
          '[class*="logout"]', '[class*="signout"]', 'a[href*="logout"]',
          '[class*="user-menu"]', '[class*="avatar"]', '[class*="profile"]'
        ];
        for (const sel of indicators) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) return { hasElement: true };
        }
        return { hasElement: false };
      },
      args: [successCheck?.elementExists]
    });
    
    if (results[0]?.result?.hasElement) {
      return { success: true, currentUrl };
    }
    
    return { success: !isStillOnLogin, currentUrl };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Check for MFA on tab
 */
async function checkForMFAOnTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const mfaSelectors = [
          'input[name*="otp"]', 'input[name*="code"]', 'input[name*="2fa"]',
          'input[name*="totp"]', 'input[placeholder*="code" i]'
        ];
        for (const sel of mfaSelectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) return { hasMFA: true };
        }
        
        const bodyText = document.body.innerText.toLowerCase();
        if (bodyText.includes('verification code') || bodyText.includes('authenticator') || 
            bodyText.includes('2-step') || bodyText.includes('two-factor')) {
          return { hasMFA: true };
        }
        return { hasMFA: false };
      }
    });
    return results[0]?.result || { hasMFA: false };
  } catch (error) {
    return { hasMFA: false };
  }
}

/**
 * Execute one-click login with hidden mode support
 */
async function executeOneClickLoginWithOptions(toolId, tool, options = {}) {
  logger.info('One-click login with options', { tool: tool.name, toolId, options });
  
  try {
    // Get credentials
    const credentialData = await getToolCredentials(toolId);
    
    const creds = credentialData?.credentials;
    const bundle = credentialData?.sessionBundle;
    const hasBundle = !!(bundle?.cookies && bundle.cookies.length) || storageHasKeys(bundle?.localStorage) || storageHasKeys(bundle?.sessionStorage);
    const hasCreds = !!(creds && creds.type && creds.type !== 'none');

    if (!credentialData || (!hasCreds && !hasBundle)) {
      const tab = await chrome.tabs.create({ url: tool.targetUrl, active: true });
      await logToolOpened(toolId);
      return { success: true, method: 'direct_open', tabId: tab.id };
    }
    
    // Get current tab if hidden mode requested
    let sourceTabId = null;
    if (options.hidden) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sourceTabId = activeTab?.id;
    }
    
    // FIX8: Use credentials then immediately clear from memory
    const result = await orchestrator.executeLogin(tool, credentialData.credentials, {
      sessionBundle: credentialData.sessionBundle,
      toolInfo: credentialData.tool,
      auto: options.auto || false,
      hidden: options.hidden || false,
      sourceTabId
    });
    
    // Credentials are scoped to this function call; no explicit clear needed
    // Log tool opened if successful
    if (result.success) {
      await logToolOpened(toolId);
    }
    
    logger.info('One-click login completed', {
      tool: tool.name,
      success: result.success,
      method: result.method,
      requiresManualAction: result.requiresManualAction
    });
    
    return result;
    
  } catch (error) {
    logger.error('One-click login error', { error: error.message });
    return { 
      success: false, 
      error: error.message,
      actionableError: 'Login failed unexpectedly. Please try again or contact support.'
    };
  }
}

/**
 * Inject content script into a tab
 */
async function injectContentScript(tabId, url) {
  try {
    // Check if we have permission for this URL
    const hasPermission = await chrome.permissions.contains({
      origins: [getOriginPattern(url)]
    });
    
    if (!hasPermission) {
      logger.debug('No permission to inject', { url: url.substring(0, 50) });
      return false;
    }
    
    // Check if content script is already injected
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__GENZ_CONTENT_INJECTED__
      });
      
      if (results[0]?.result === true) {
        return true;
      }
    } catch (e) {
      // Script not injected yet
    }
    
    // Inject the content script
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['js/content.js']
    });
    
    // Mark as injected
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { window.__GENZ_CONTENT_INJECTED__ = true; }
    });
    
    logger.debug('Content script injected', { tabId });
    return true;
  } catch (error) {
    logger.warn('Content script injection failed', { error: error.message });
    return false;
  }
}

/**
 * Inject the account/logout SHIELD (js/shield.js) into an extension-opened tool tab.
 * Hides shared-account chrome (account/profile menu, logout, billing, upgrade,
 * subscription, settings) and guards clicks to logout/account/billing routes so the
 * member can't read shared account details or log the shared account out. Config comes
 * from the single source of truth in config/toolConfigs.js. Fire-and-forget, idempotent,
 * never blocks the auto-login flow. Cosmetic only — touches no cookies/tokens/secrets.
 */
async function injectShield(tabId, url, tool) {
  try {
    const cfg = getShieldConfig(url, tool);
    if (!cfg || cfg.enabled === false) return false;
    const hasPermission = await chrome.permissions.contains({ origins: [getOriginPattern(url)] });
    if (!hasPermission) return false;
    // Set config in the page's isolated world, then inject the shield (idempotent on the
    // page side: a re-injection just refreshes config + re-sweeps).
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (c) => { window.__GENZ_SHIELD_CFG__ = c; },
      args: [cfg]
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['js/shield.js'] });
    logger.debug('Shield injected', { tabId });
    return true;
  } catch (error) {
    logger.warn('Shield injection failed', { error: error.message });
    return false;
  }
}

// FIX7: Initialization handled by onInstalled and onStartup listeners only
// Do NOT call initialize() here — it causes triple initialization on fresh install.
logger.info('Gen Z Digital Store Extension v2.1 background worker loaded');

// ============================================================================
// WEBSITE ↔ EXTENSION HANDSHAKE
// Allows genzdigitalstore.com to check if extension is installed/version
// ============================================================================
chrome.runtime.onMessageExternal?.addListener((message, sender, sendResponse) => {
  // Validate sender origin
  const allowedOrigins = [
    'https://genzdigitalstore.com',
    'https://app.genzdigitalstore.com',
    'http://localhost:3000'
  ];
  if (!allowedOrigins.some(o => sender.origin?.startsWith(o))) {
    sendResponse({ error: 'Unauthorized origin' });
    return false;
  }

  if (message.type === 'GENZ_EXT_PING') {
    getStorage(['extensionToken', 'tools', 'lastSync']).then(d => {
      sendResponse({
        installed: true,
        connected: !!d.extensionToken,
        toolCount: (d.tools || []).length,
        lastSync: d.lastSync || null,
        version: chrome.runtime.getManifest().version,
        name: chrome.runtime.getManifest().name
      });
    });
    return true;
  }

  sendResponse({ error: 'Unknown message type' });
  return false;
});
