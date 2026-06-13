import api from './api';

// Separate localStorage keys for admin and client — prevents cross-session contamination
const ADMIN_USER_KEY = 'genz_admin_user';
const CLIENT_USER_KEY = 'genz_client_user';

class AuthService {
  // ─── Admin login ─────────────────────────────────────────────────────────
  async adminLogin(email, password) {
    const response = await api.post('/auth/admin/login', { email, password });
    if (response.data.success) {
      localStorage.setItem(ADMIN_USER_KEY, JSON.stringify(response.data.user));
      return response.data.user;
    }
    throw new Error(response.data.error || 'Login failed');
  }

  // ─── Client login ─────────────────────────────────────────────────────────
  async clientLogin(email, password, deviceId) {
    const response = await api.post('/auth/client/login', { email, password, deviceId });
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
}

export const authService = new AuthService();
