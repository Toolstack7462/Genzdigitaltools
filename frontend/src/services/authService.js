import api from './api';

class AuthService {
  // ─── Admin login ─────────────────────────────────────────────────────────
  async adminLogin(email, password) {
    const response = await api.post('/auth/admin/login', { email, password });
    if (response.data.success) {
      // FIX1: Tokens are httpOnly cookies set by server. Only cache user object.
      localStorage.setItem('crm_user', JSON.stringify(response.data.user));
      return response.data.user;
    }
    throw new Error(response.data.error || 'Login failed');
  }

  // ─── Client login ─────────────────────────────────────────────────────────
  async clientLogin(email, password, deviceId) {
    const response = await api.post('/auth/client/login', { email, password, deviceId });
    if (response.data.success) {
      localStorage.setItem('crm_user', JSON.stringify(response.data.user));
      return response.data.user;
    }
    throw new Error(response.data.error || 'Login failed');
  }

  // ─── Logout ───────────────────────────────────────────────────────────────
  async logout() {
    try {
      // withCredentials sends httpOnly cookies automatically
      await api.post('/auth/logout', {});
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      localStorage.removeItem('crm_user');
    }
  }

  // ─── Refresh (cookie-driven, no body needed) ──────────────────────────────
  async refreshToken() {
    // Cookie is sent automatically via withCredentials
    const response = await api.post('/auth/refresh', {});
    if (response.data.success) return true;
    throw new Error('Token refresh failed');
  }

  // ─── Verify session with server (for route guards) ────────────────────────
  async verifySession() {
    try {
      const response = await api.get('/auth/me');
      if (response.data.success) {
        // Keep cache in sync
        localStorage.setItem('crm_user', JSON.stringify(response.data.user));
        return response.data.user;
      }
      return null;
    } catch {
      localStorage.removeItem('crm_user');
      return null;
    }
  }

  // ─── getMe alias (calls verifySession) ──────────────────────────────────────
  async getMe() {
    return this.verifySession();
  }

  // ─── Local cache helpers (display only, not security boundary) ───────────
  getCurrentUser() {
    try {
      const str = localStorage.getItem('crm_user');
      return str ? JSON.parse(str) : null;
    } catch {
      return null;
    }
  }

  isAuthenticated() {
    return !!localStorage.getItem('crm_user');
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
