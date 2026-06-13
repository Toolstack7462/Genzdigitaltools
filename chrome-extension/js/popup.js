/**
 * popup.js — Status-only popup for Gen Z Digital Store Extension
 *
 * The popup shows:
 *  - Connection status (connected / disconnected)
 *  - Session info (email, tool count, last sync, access policy)
 *  - Open Dashboard button
 *  - Sync Now button
 *  - Sign Out button
 *  - Reconnect guidance when disconnected
 *  - Security scanner active status
 *
 * Tools are NOT opened from here. The member dashboard is the launcher.
 */

import { Storage, ApiClient } from './api.js';

const api = new ApiClient();

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const extVersion       = $('ext-version');
const headerBadge      = $('header-badge');
const statusDot        = $('status-dot');
const statusLabel      = $('status-label');
const statusDetail     = $('status-detail');
const connectedSection = $('connected-section');
const connectedActions = $('connected-actions');
const disconnectedSection = $('disconnected-section');
const userEmail        = $('user-email');
const toolCount        = $('tool-count');
const lastSyncEl       = $('last-sync');
const tokenExpiresEl   = $('token-expires');
const openDashBtn      = $('open-dashboard-btn');
const syncBtn          = $('sync-btn');
const logoutBtn        = $('logout-btn');
const reconnectBtn     = $('reconnect-btn');
// Security scanner is active by default. Popup shows status only.

// ── Init ────────────────────────────────────────────────────────────────────


// ── Connected state ──────────────────────────────────────────────────────────
function showConnected(data) {
  // Header badge
  headerBadge.textContent = '● Connected';
  headerBadge.className = 'badge badge-connected';

  // Status dot + label
  statusDot.className = 'status-dot dot-connected';
  statusLabel.textContent = 'Connected';
  statusDetail.textContent = 'Extension is active and ready';

  // Session info
  userEmail.textContent = data.userEmail || '—';
  toolCount.textContent = data.tools ? `${data.tools.length} tools` : '—';
  lastSyncEl.textContent = data.lastSync ? relativeTime(data.lastSync) : 'Never';
  tokenExpiresEl.textContent = 'Managed by admin';

  // Show sections
  connectedSection.classList.remove('hidden');
  connectedActions.classList.remove('hidden');
  disconnectedSection.classList.add('hidden');
}

// ── Disconnected state ───────────────────────────────────────────────────────
function showDisconnected(detail = 'Not connected.') {
  headerBadge.textContent = '● Disconnected';
  headerBadge.className = 'badge badge-disconnected';

  statusDot.className = 'status-dot dot-disconnected';
  statusLabel.textContent = 'Disconnected';
  statusDetail.textContent = detail;

  connectedSection.classList.add('hidden');
  connectedActions.classList.add('hidden');
  disconnectedSection.classList.remove('hidden');
}

// ── Button handlers ──────────────────────────────────────────────────────────
openDashBtn.addEventListener('click', () => {
  const DASHBOARD_URL = 'https://app.genzdigitalstore.com/client/dashboard';
  chrome.tabs.create({ url: DASHBOARD_URL });
  window.close();
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = '⏳ Syncing…';
  chrome.runtime.sendMessage({ type: 'CHECK_UPDATES' }, () => {
    Storage.get(['lastSync', 'tools']).then(d => {
      lastSyncEl.textContent = d.lastSync ? relativeTime(d.lastSync) : 'Just now';
      if (d.tools) toolCount.textContent = `${d.tools.length} tools`;
    });
    syncBtn.disabled = false;
    syncBtn.textContent = '🔄 Sync Tools Now';
    showToast('Synced!', 'success');
  });
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  try {
    await api.logout();
  } catch {}
  await Storage.clear();
  showDisconnected('Signed out. Open the client dashboard to auto-connect again.');
  showToast('Signed out', 'info');
  logoutBtn.disabled = false;
});

// Reconnect-now: find a logged-in dashboard tab, focus it, and tell it to run
// a forced reconnect. If no dashboard tab is open, open one — the bridge
// auto-pairs as soon as the page loads.
reconnectBtn?.addEventListener('click', async () => {
  const DASHBOARD_URL = 'https://app.genzdigitalstore.com/client/dashboard';
  const DASHBOARD_ORIGINS = [
    'https://app.genzdigitalstore.com',
    'https://genzdigitalstore.com',
    'http://localhost:3000',
  ];
  reconnectBtn.disabled = true;
  const original = reconnectBtn.textContent;
  reconnectBtn.textContent = '⏳ Reconnecting…';
  try {
    const tabs = await chrome.tabs.query({});
    const dashTab = (tabs || []).find(t => {
      try { return t.url && DASHBOARD_ORIGINS.includes(new URL(t.url).origin); }
      catch { return false; }
    });
    if (dashTab) {
      try {
        await chrome.tabs.update(dashTab.id, { active: true });
        if (dashTab.windowId) await chrome.windows.update(dashTab.windowId, { focused: true });
      } catch {}
      // Bridge content script forwards SAFE_PUSH messages into the page —
      // useExtension listens for GENZ_FORCE_RECONNECT and re-runs connect.
      chrome.tabs.sendMessage(dashTab.id, { type: 'GENZ_FORCE_RECONNECT' }).catch(() => {});
      showToast('Reconnecting from dashboard…', 'info');
    } else {
      chrome.tabs.create({ url: DASHBOARD_URL });
      showToast('Opening dashboard…', 'info');
    }
  } catch (err) {
    showToast('Could not reconnect — open the dashboard manually', 'error');
  } finally {
    setTimeout(() => {
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = original;
      window.close();
    }, 600);
  }
});


// ── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show ${type}`;
  setTimeout(() => t.className = '', 3000);
}

// ── Relative time ────────────────────────────────────────────────────────────
function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000)    return 'Just now';
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Security scanner status ─────────────────────────────────────────────────
async function ensureScannerEnabled() {
  chrome.runtime.sendMessage({ type: 'GENZ_ENABLE_SCANNER_AUTO' }, () => {});
}

// ── Start ────────────────────────────────────────────────────────────────────
async function init() {
  const manifest = chrome.runtime.getManifest();
  extVersion.textContent = manifest.version;

  await api.init();

  const data = await Storage.get([
    'extensionToken', 'apiUrl', 'tools', 'lastSync',
    'userEmail',
  ]);

  if (data.extensionToken) {
    showConnected(data);
    chrome.runtime.sendMessage({ type: 'GENZ_GET_EXTENSION_STATUS' }, resp => {
      if (!resp?.connected) {
        showDisconnected('Open the client dashboard to auto-connect.');
      }
    });
  } else {
    showDisconnected('Open the client dashboard to auto-connect.');
  }

  // Keep security scanner active by default
  ensureScannerEnabled();
}

init();
