import api from './api';

// Separate localStorage keys for admin and client — prevents cross-session contamination
const ADMIN_USER_KEY = 'genz_admin_user';
const CLIENT_USER_KEY = 'genz_client_user';

// The backend (Passenger on shared hosting) recycles periodically; during the brief
// restart window a request can get NO response or a 502/503/504. That made login
// intermittently show "Login failed" even with correct credentials. Retry such
// TRANSIENT failures once after a short delay so a restart blip is invisible to users.
// Only retries on no-response / gateway errors — a real 401/403/400 is returned
// immediately (never retried), so it does not mask genuine credential errors.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function postWithRetry(url, body, { retries = 2, delayMs = 1200, timeout = 15000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      // Bound each attempt so a hung request (cold start) fails fast and resets the UI
      // instead of spinning forever — a slow-but-normal login (~3-4s) is well within this.
      return await api.post(url, body, { timeout });
    } catch (err) {
      // IMPORTANT: a client-side TIMEOUT (ECONNABORTED) is NOT retried — the server may
      // still be processing the request, and re-sending a non-idempotent login would
      // create a second session/token for one click. Only retry when the request
      // demonstrably did NOT execute on the server: a connection-level failure (refused/
      // reset during a restart) or a gateway error (proxy up, app down).
      const isTimeout = err.code === 'ECONNABORTED';
      const connFailed = err.request && !err.response && !isTimeout;
      const gateway = err.response && [502, 503, 504].includes(err.response.status);
      if (attempt < retries && (connFailed || gateway)) {
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

class AuthService {
  // ─── Admin login ─────────────────────────────────────────────────────────
  async adminLogin(email, password) {
    // 30s (not the 15s default): the API runs on shared hosting (Passenger) and a
    // cold start after idle can take 20s+. A too-short timeout aborts a login that
    // would otherwise succeed and shows a misleading "Login failed". Timeouts are
    // still NOT retried (see postWithRetry) so this never double-submits.
    const response = await postWithRetry('/auth/admin/login', { email, password }, { timeout: 30000 });
    if (response.data.success) {
      localStorage.setItem(ADMIN_USER_KEY, JSON.stringify(response.data.user));
      return response.data.user;
    }
    throw new Error(response.data.error || 'Login failed');
  }

  // ─── Client login ─────────────────────────────────────────────────────────
  async clientLogin(email, password, deviceId, extra = {}) {
    // 30s timeout — see adminLogin: absorbs shared-hosting cold starts so a slow-but-
    // valid login is not aborted and surfaced as a generic "Login failed".
    const response = await postWithRetry('/auth/client/login', { email, password, deviceId, ...extra }, { timeout: 30000 });
    if (response.data.success) {
      localStorage.setItem(CLIENT_USER_KEY, JSON.stringify(response.data.user));
      return response.data.user;
    }
    throw new Error(response.data.error || 'Login failed');
  }

  // ─── Admin logout ─────────────────────────────────────────────────────────
  async adminLogout() {
    try {
      await api.post('/auth/admin/logout', {});
    } catch (err) {
      console.error('Admin logout error:', err);
    } finally {
      localStorage.removeItem(ADMIN_USER_KEY);
    }
  }

  // ─── Client logout ────────────────────────────────────────────────────────
  async clientLogout() {
    try {
      await api.post('/auth/client/logout', {});
    } catch (err) {
      console.error('Client logout error:', err);
    } finally {
      localStorage.removeItem(CLIENT_USER_KEY);
    }
  }

  // ─── Generic logout (backward compat) ────────────────────────────────────
  async logout() {
    try {
      await api.post('/auth/logout', {});
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      localStorage.removeItem(ADMIN_USER_KEY);
      localStorage.removeItem(CLIENT_USER_KEY);
    }
  }

  // ─── Verify admin session (for AdminRoute) ────────────────────────────────
  async verifyAdminSession() {
    try {
      const response = await api.get('/auth/admin/me');
      if (response.data.success) {
        localStorage.setItem(ADMIN_USER_KEY, JSON.stringify(response.data.user));
        return response.data.user;
      }
      return null;
    } catch {
      localStorage.removeItem(ADMIN_USER_KEY);
      return null;
    }
  }

  // ─── Verify client session (for ClientRoute) ─────────────────────────────
  async verifyClientSession() {
    try {
      const response = await api.get('/auth/client/me');
      if (response.data.success) {
        localStorage.setItem(CLIENT_USER_KEY, JSON.stringify(response.data.user));
        return response.data.user;
      }
      return null;
    } catch {
      localStorage.removeItem(CLIENT_USER_KEY);
      return null;
    }
  }

  // ─── verifySession alias — defaults to client (backward compat) ───────────
  async verifySession() {
    return this.verifyClientSession();
  }

  // ─── getMe alias ─────────────────────────────────────────────────────────
  async getMe() {
    return this.verifyClientSession();
  }

  // ─── Local cache helpers (display only, not security boundary) ────────────
  getAdminUser() {
    try {
      const str = localStorage.getItem(ADMIN_USER_KEY);
      return str ? JSON.parse(str) : null;
    } catch {
      return null;
    }
  }

  getClientUser() {
    try {
      const str = localStorage.getItem(CLIENT_USER_KEY);
      return str ? JSON.parse(str) : null;
    } catch {
      return null;
    }
  }

  // getCurrentUser returns client user (used by client pages)
  getCurrentUser() {
    return this.getClientUser();
  }

  isAuthenticated() {
    return !!(localStorage.getItem(ADMIN_USER_KEY) || localStorage.getItem(CLIENT_USER_KEY));
  }

  isAdminAuthenticated() {
    return !!localStorage.getItem(ADMIN_USER_KEY);
  }

  isClientAuthenticated() {
    return !!localStorage.getItem(CLIENT_USER_KEY);
  }

  // ─── Device ID (UUID v4) ──────────────────────────────────────────────────
  getOrCreateDeviceId() {
    let id = localStorage.getItem('device_id');
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : this._fallbackUUID();
      localStorage.setItem('device_id', id);
    }
    return id;
  }

  _fallbackUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // ─── Device fingerprint (cross-browser, best-effort) ──────────────────────
  // Stable across browsers on the SAME machine: OS + screen + timezone + cores.
  // No hardware IDs (browsers can't read them). Backend hashes this; we send the
  // raw string so the server stores only the hash. NOT a tracking identifier.
  getDeviceFingerprint() {
    try {
      const s = window.screen || {};
      const parts = [
        (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
        `${s.width || 0}x${s.height || 0}`,
        s.colorDepth || '',
        Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        navigator.hardwareConcurrency || '',
        navigator.maxTouchPoints || 0,
      ];
      return parts.join('|');
    } catch {
      return '';
    }
  }

  // Human-readable OS/browser for the admin device list (display only).
  getDeviceInfo() {
    const ua = navigator.userAgent || '';
    let os = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'Unknown';
    let browser = 'Browser';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = 'Opera';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua)) browser = 'Safari';
    return { os: String(os).slice(0, 64), browser };
  }
}

export const authService = new AuthService();
