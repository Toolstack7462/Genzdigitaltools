/**
 * popup.js — Readiness-only popup for Gen Z Digital Store Extension
 *
 * Readiness model: if this popup is running, the extension is installed and
 * enabled, so it is ALWAYS "Extension Ready". We never show "Disconnected",
 * "Reconnect", "Auto connecting", or "session expired" — the secure dashboard
 * session is paired on-demand when the member clicks Access on a tool.
 *
 * The popup shows:
 *  - Extension Ready status (always)
 *  - Session info when a dashboard session is already paired
 *  - Open Dashboard button (always)
 *  - Sync Now / Sign Out (only when a session is paired)
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
// Security scanner is active by default. Popup shows status only.

// ── Ready state (the only state the popup ever shows) ────────────────────────
// hasSession = a dashboard session is already paired (extension token present).
// When false we still show "Extension Ready" — just with get-started guidance
// instead of session info. We never render a red "Disconnected" state.
function renderReady(data = {}, hasSession = false) {
  headerBadge.textContent = '● Ready';
  headerBadge.className = 'badge badge-connected';

  statusDot.className = 'status-dot dot-connected';
  statusLabel.textContent = 'Extension Ready';
  statusDetail.textContent = hasSession
    ? 'Active — open your tools from the member dashboard.'
    : 'Open your member dashboard, then click Access on a tool.';

  if (hasSession) {
    userEmail.textContent = data.userEmail || '—';
    toolCount.textContent = data.tools ? `${data.tools.length} tools` : '—';
    lastSyncEl.textContent = data.lastSync ? relativeTime(data.lastSync) : 'Just now';
    tokenExpiresEl.textContent = 'Managed by admin';
    connectedSection.classList.remove('hidden');
    syncBtn.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
  } else {
    connectedSection.classList.add('hidden');
    syncBtn.classList.add('hidden');
    logoutBtn.classList.add('hidden');
  }
  // "Open Member Dashboard" is always available; the disconnected panel is gone.
  connectedActions.classList.remove('hidden');
  disconnectedSection.classList.add('hidden');
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
  // Still "Ready" — just no paired session. No "Disconnected" wording.
  renderReady({}, false);
  showToast('Signed out', 'info');
  logoutBtn.disabled = false;
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

// ── Update banner ─────────────────────────────────────────────────────────
// Shows when the backend heartbeat reported a newer (or required) version.
// The button uses the EXISTING /downloads/ link (no separate download flow).
function appOriginFromApiUrl(apiUrl) {
  try {
    const u = new URL(String(apiUrl || ''));
    return `${u.protocol}//${u.host.replace(/^api\./, 'app.')}`;
  } catch (_) { return 'https://app.genzdigitalstore.com'; }
}

function renderUpdateBanner(update, apiUrl) {
  const banner = $('update-banner');
  if (!banner || !update || (!update.updateAvailable && !update.updateRequired)) return;
  const required = !!update.updateRequired;
  const title = $('update-title');
  const detail = $('update-detail');
  const link = $('update-link');
  if (title) title.textContent = required ? 'Update required' : 'Update available';
  if (detail) {
    detail.textContent = required
      ? 'Your access is paused until you update to the latest extension.'
      : `A newer version (${update.latest || 'latest'}) is available. Please update.`;
  }
  if (link) {
    const origin = appOriginFromApiUrl(apiUrl);
    const v = update.latest ? `?v=${encodeURIComponent(update.latest)}` : '';
    link.href = `${origin}${update.downloadPath || '/downloads/genz-digital-store-extension.zip'}${v}`;
  }
  banner.classList.remove('hidden');
}

// ── Start ────────────────────────────────────────────────────────────────────
async function init() {
  const manifest = chrome.runtime.getManifest();
  extVersion.textContent = manifest.version;

  await api.init();

  const data = await Storage.get([
    'extensionToken', 'apiUrl', 'tools', 'lastSync',
    'userEmail', 'extensionUpdate',
  ]);

  // Surface any pending extension update (stored by the background heartbeat).
  renderUpdateBanner(data.extensionUpdate, data.apiUrl);

  // The popup only runs when the extension is installed & enabled → always Ready.
  renderReady(data, !!data.extensionToken);

  // If a session is paired, refresh its info in the background. This NEVER flips
  // the popup to a "Disconnected" state — at worst the session info stays as-is.
  if (data.extensionToken) {
    chrome.runtime.sendMessage({ type: 'GENZ_GET_EXTENSION_STATUS' }, resp => {
      if (resp) {
        renderReady({
          ...data,
          userEmail: resp.userEmail || data.userEmail,
          lastSync: resp.lastSync || data.lastSync,
        }, true);
      }
    });
  }

  // Keep security scanner active by default
  ensureScannerEnabled();
}

init();
