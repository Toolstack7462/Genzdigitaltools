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

// Initialize logger
const logger = new Logger('Background');

// Constants
const SYNC_INTERVAL_MINUTES = 15;
const ALARM_NAME = 'genz-sync';

// State
let orchestrator = null;
let isInitialized = false; // FIX7: prevent duplicate initialization
let activeLogins = new Map();
let toolCredentialsCache = new Map();
let domainToolMap = new Map();
// Duplicate open lock: toolId → timestamp; prevents double-open within 3s
let openIntentLock = new Map();

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

async function apiRequest(endpoint, options = {}) {
  const data = await getStorage(['apiUrl', 'extensionToken']);
  
  if (!data.apiUrl || !data.extensionToken) {
    throw new Error('Not authenticated');
  }
  
  const url = `${data.apiUrl}/api/crm/extension${endpoint}`;
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
  const result = await response.json();

  if (response.status === 401 || response.status === 403) {
    // Token revoked or expired — clear local state and notify any open dashboard tabs
    logger.warn('Extension token rejected by server, clearing session', { status: response.status });
    await removeStorage(['extensionToken', 'tools', 'toolVersions', 'sessionBundleVersions']);
    toolCredentialsCache.clear();
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    // Notify dashboard tabs so they can show reconnect UI
    notifyDashboardTabs({ type: 'GENZ_EXTENSION_DISCONNECTED', reason: response.status === 401 ? 'token_expired' : 'token_revoked' });
    throw new Error(result.error || 'Session expired');
  }

  if (!response.ok) {
    throw new Error(result.error || 'Request failed');
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
  logger.info('Initializing Gen Z Digital Store Extension v3.4');
  
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
  
  logger.debug(`Sync alarm set for every ${SYNC_INTERVAL_MINUTES} minutes`);
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
    
    await setStorage({ lastSync: new Date().toISOString() });
    
  } catch (error) {
    logger.error('Sync check failed', { error: error.message });
    
    if (error.message.includes('token') || error.message.includes('401')) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
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
    // Get credentials (includes session bundle)
    const credentialData = await getToolCredentials(tool.id);
    
    if (!credentialData || !credentialData.credentials) {
      logger.warn('No credentials for tool', { tool: tool.name });
      return;
    }
    
    // Use orchestrator for login with session bundle
    const result = await orchestrator.executeLogin(tool, credentialData.credentials, {
      tabId,
      currentUrl: url,
      sessionBundle: credentialData.sessionBundle,
      toolInfo: credentialData.tool
    });
    
    logger.info('Auto-login result', { 
      tool: tool.name, 
      success: result.success, 
      method: result.method,
      sessionBundleApplied: !!credentialData.sessionBundle
    });
    
  } catch (error) {
    logger.error('Auto-login failed', { error: error.message });
  } finally {
    // Clear active login
    activeLogins.delete(tabId);
  }
}

/**
 * Get credentials for a tool (with caching)
 */
async function getToolCredentials(toolId) {
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

    // Return the full shape callers expect
    // Credentials are NOT cached — they are returned once and must be used immediately
    return {
      credentials: result.credentials,
      sessionBundle: result.sessionBundle,
      tool: result.tool,
      credentialVersion: result.tool?.credentialVersion,
      domain: result.tool?.domain,
      timestamp: Date.now()
    };
  } catch (error) {
    logger.error('Failed to fetch credentials', { error: error.message });
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
    const hasBundle = !!(bundle?.cookies || bundle?.localStorage || bundle?.sessionStorage);
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
      actionRequired: 'Grant access to this domain in the extension popup before opening this tool.',
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
      
      // Normalize sameSite
      let sameSite = (cookie.sameSite || 'lax').toLowerCase();
      if (sameSite === 'no_restriction' || sameSite === 'none') {
        sameSite = 'no_restriction';
      } else if (sameSite === 'strict') {
        sameSite = 'strict';
      } else {
        sameSite = 'lax';
      }
      
      // SameSite=None requires Secure
      const finalSecure = sameSite === 'no_restriction' ? true : secure;
      const protocol = finalSecure ? 'https' : 'http';
      const cleanDomain = cookieDomain.startsWith('.') ? cookieDomain.substring(1) : cookieDomain;
      const cookieUrl = `${protocol}://${cleanDomain}/`;
      
      const cookieDetails = {
        url: cookieUrl,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: finalSecure,
        httpOnly: cookie.httpOnly === true,
        sameSite: sameSite
      };
      
      // Set domain for subdomain cookies
      if (cookieDomain.startsWith('.')) {
        cookieDetails.domain = cookieDomain;
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
      
      const result = await chrome.cookies.set(cookieDetails);
      if (result) {
        setCount++;
      } else {
        throw new Error('Cookie set returned null');
      }
    } catch (error) {
      failedCount++;
      failures.push({ name: cookie.name, error: error.message });
    }
  }
  
  logger.debug('Cookie injection complete', { set: setCount, failed: failedCount });
  
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
// GENZ_OPEN_TOOL — Dashboard-triggered tool open
// Flow: Dashboard → bridge.js postMessage → background.js → verify intent
//       → fetch credentials → open/reuse tab → run strategy
// ============================================================================

/**
 * Open a tool triggered by the dashboard Access button.
 * Steps:
 *  1. Verify the openIntentToken with the backend (anti-forgery).
 *  2. Duplicate-open lock (3s debounce per toolId).
 *  3. Load tool info from cached tool list.
 *  4. Check host permission; return permission_required if missing.
 *  5. Find or create a tab for the tool.
 *  6. Determine strategy: direct_open / sessionBundle / cookies / form / sso / token.
 *  7. Execute strategy via LoginOrchestrator.
 *  8. Log success to backend.
 */
async function handleOpenTool(payload) {
  const { toolId, openIntentToken } = payload || {};

  if (!toolId || typeof toolId !== 'string') {
    return { success: false, error: 'toolId required' };
  }

  // ── 1. Verify intent token with backend ──────────────────────────────────
  if (!openIntentToken || typeof openIntentToken !== 'string') {
    return { success: false, error: 'openIntentToken required' };
  }
  try {
    const verifyResult = await apiRequest('/verify-intent', {
      method: 'POST',
      body: JSON.stringify({ intentToken: openIntentToken, toolId }),
    });
    if (!verifyResult.verified) {
      return { success: false, error: 'Intent verification failed' };
    }
  } catch (err) {
    logger.warn('Intent verification error', { error: err.message });
    return { success: false, error: 'Intent verification failed: ' + err.message };
  }

  // ── 2. Duplicate-open lock (3-second debounce) ────────────────────────────
  const now = Date.now();
  if (openIntentLock.has(toolId) && now - openIntentLock.get(toolId) < 3000) {
    logger.debug('Duplicate open suppressed', { toolId });
    return { success: false, error: 'already_opening' };
  }
  openIntentLock.set(toolId, now);
  // Auto-clear lock after 15 seconds
  setTimeout(() => openIntentLock.delete(toolId), 15000);

  // ── 3. Load tool info ─────────────────────────────────────────────────────
  let stored = await getStorage(['tools']);
  let tool = (stored.tools || []).find(t => t.id === toolId);
  if (!tool) {
    logger.info('Tool not found in cache; refreshing tool list', { toolId });
    await checkForUpdates();
    stored = await getStorage(['tools']);
    tool = (stored.tools || []).find(t => t.id === toolId);
  }
  if (!tool) {
    openIntentLock.delete(toolId);
    return { success: false, error: 'tool_not_synced', message: 'Tool not found after sync. Reconnect extension and try again.' };
  }

  const targetUrl = tool.targetUrl;
  if (!targetUrl) {
    return { success: false, error: 'Tool has no targetUrl configured' };
  }

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
      message: 'Grant access to this tool domain in the extension popup, then try again.',
    };
  }

  // ── 5. Find or reuse existing tab ─────────────────────────────────────────
  let targetTabId = null;
  try {
    const toolHostname = new URL(targetUrl).hostname;
    const existingTabs = await chrome.tabs.query({ url: `*://${toolHostname}/*` });
    if (existingTabs.length > 0) {
      targetTabId = existingTabs[0].id;
      // Bring the existing tab to focus
      await chrome.tabs.update(targetTabId, { active: true });
      await chrome.windows.update(existingTabs[0].windowId, { focused: true });
      logger.debug('Reusing existing tab', { tabId: targetTabId, toolId });
    }
  } catch {}

  if (!targetTabId) {
    const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
    targetTabId = newTab.id;
    logger.debug('Opened new tab', { tabId: targetTabId, toolId });
  }

  // ── 6. Fetch credentials from backend ─────────────────────────────────────
  let credentialData = null;
  try {
    credentialData = await getToolCredentials(toolId);
  } catch (err) {
    logger.warn('Credential fetch failed', { error: err.message });
  }

  // ── 7. Determine and execute strategy ─────────────────────────────────────
  const creds       = credentialData?.credentials;
  const bundle      = credentialData?.sessionBundle;
  const credType    = creds?.type || 'none';
  const hasBundle   = !!(bundle?.cookies || bundle?.localStorage || bundle?.sessionStorage);
  const hasCreds    = !!(creds && credType !== 'none');

  logger.info('Opening tool', { toolId, credType, hasBundle, hasCreds });

  // direct_open: no credentials and no session bundle
  if (!hasCreds && !hasBundle) {
    logger.info('Strategy: direct_open', { toolId });
    await logToolOpened(toolId);
    openIntentLock.delete(toolId);
    return { success: true, method: 'direct_open', tabId: targetTabId };
  }

  // sessionBundle only (no form/token credentials)
  if (hasBundle && !hasCreds) {
    logger.info('Strategy: sessionBundle_only', { toolId });
    try {
      await waitForTabLoad(targetTabId, 15000);
      if (tool.extensionSettings?.clearExistingCookies) {
        await clearCookiesForDomain(targetUrl);
      }
      if (bundle.cookies) {
        await injectCookies(targetUrl, bundle.cookies);
      }
      if (bundle.localStorage) {
        await injectStorage(targetTabId, 'localStorage', bundle.localStorage);
      }
      if (bundle.sessionStorage) {
        await injectStorage(targetTabId, 'sessionStorage', bundle.sessionStorage);
      }
      await chrome.tabs.reload(targetTabId);
      await logToolOpened(toolId);
    } catch (err) {
      logger.warn('SessionBundle apply failed', { error: err.message });
      openIntentLock.delete(toolId);
      return { success: false, error: err.message, actionableError: 'Session data could not be applied. Please contact admin.' };
    }
    openIntentLock.delete(toolId);
    return { success: true, method: 'session_bundle', tabId: targetTabId };
  }

  // Full strategy execution via orchestrator
  try {
    await waitForTabLoad(targetTabId, 20000);
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
        result.actionableError = 'Host permission missing. Open the extension popup and grant access.';
      }
    }

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

function scoreExtension(ext) {
  if (ext.id === chrome.runtime.id) return null; // Skip ourselves

  const perms   = ext.permissions || [];
  const hostPerm = (ext.hostPermissions || []).join(' ');
  const hasCookies  = perms.includes('cookies');
  const hasAllUrls  = hostPerm.includes('<all_urls>') || hostPerm.includes('https://*/*') || hostPerm.includes('http://*/*');
  const hasTabs     = perms.includes('tabs') || perms.includes('activeTab');
  const nameMatch   = RISKY_KEYWORDS.some(k => ext.name?.toLowerCase().includes(k));

  let riskLevel = null;
  if (hasCookies && hasAllUrls) {
    riskLevel = 'high';
  } else if (hasCookies || (hasAllUrls && hasTabs)) {
    riskLevel = 'medium';
  } else if (nameMatch) {
    riskLevel = 'medium';
  } else if (hasTabs && hasAllUrls) {
    riskLevel = 'low';
  }

  if (!riskLevel) return null;

  const permParts = [];
  if (hasCookies)  permParts.push('cookies');
  if (hasTabs)     permParts.push('tabs');
  if (hasAllUrls)  permParts.push('<all_urls>');

  return {
    extId:              ext.id,
    extName:            ext.name || 'Unknown',
    riskLevel,
    permissionsSummary: permParts.join(', ') || 'other',
  };
}

async function runExtensionScan() {
  // 1. Scanner is active by default after extension connection.
  // It sends only safe extension metadata, never cookie values or browsing history.
  const stored = await getStorage(['scannerEnabled', 'extensionToken']);
  if (!stored.extensionToken) return;
  if (stored.scannerEnabled === false) return;

  // 2. Check if chrome.management is available
  if (!chrome.management?.getAll) {
    logger.debug('Extension scan skipped — chrome.management not available');
    return;
  }

  try {
    const allExtensions = await new Promise(res => chrome.management.getAll(res));
    const riskyExtensions = allExtensions
      .map(scoreExtension)
      .filter(Boolean);

    logger.info('Extension scan complete', {
      total: allExtensions.length,
      risky: riskyExtensions.length,
      high: riskyExtensions.filter(e => e.riskLevel === 'high').length,
    });

    if (riskyExtensions.length > 0) {
      // Notify popup/badge
      const highCount = riskyExtensions.filter(e => e.riskLevel === 'high').length;
      if (highCount > 0) {
        chrome.action.setBadgeText({ text: '⚠' });
        chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
        // Show a notification — transparent wording, no claim of data theft
        chrome.notifications.create('risk-scan-' + Date.now(), {
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Security Notice — Gen Z Digital Store',
          message: `${highCount} browser extension(s) with broad data access detected on this device. Your admin has been notified. No action needed unless support contacts you.`,
          priority: 1,
        });
      }
    }

    // 3. Report to backend (safe metadata only)
    await apiRequest('/security-scan', {
      method: 'POST',
      body: JSON.stringify({
        riskyExtensions,
        userConsentGiven: true,
        scannerEnabled: true,
      }),
    });

  } catch (err) {
    logger.warn('Extension scan failed', { error: err.message });
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
  }
});

// Install/Update listener
chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed/updated', { reason: details.reason });
  initialize();
  setTimeout(() => injectBridgeIntoDashboardTabs(`onInstalled:${details.reason}`), 500);
});

// Startup listener
chrome.runtime.onStartup.addListener(() => {
  logger.info('Browser started');
  initialize();
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
      getStorage(['extensionToken', 'lastSync', 'tools']).then(d => {
        sendResponse({
          success: true,
          connected: !!d.extensionToken,
          toolCount: (d.tools || []).length,
          lastSync: d.lastSync || null,
          version: chrome.runtime.getManifest().version,
        });
      });
      return true;

    case 'GENZ_CONNECT_EXTENSION':
      (async () => {
        const { apiUrl, email, password, activationToken } = message.payload || {};
        if (!apiUrl || (!activationToken && (!email || !password))) {
          sendResponse({ success: false, error: 'apiUrl and activationToken required' });
          return;
        }
        try {
          const base = apiUrl.replace(/\/$/, '');
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
            sendResponse({ success: false, error: d.error || 'Authentication failed' });
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
      getStorage(['scanConsentGivenAt', 'scannerEnabled']).then(d => {
        sendResponse({
          consentGiven: d.scannerEnabled !== false,
          scannerEnabled: d.scannerEnabled !== false,
          consentDate: d.scanConsentGivenAt || null,
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
      handleOpenTool(message.payload || {})
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
    const hasBundle = !!(bundle?.cookies || bundle?.localStorage || bundle?.sessionStorage);
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
