import axios from 'axios';

function getApiBaseUrl() {
  const envUrl = process.env.REACT_APP_BACKEND_URL;
  if (envUrl) {
    try {
      const cleanUrl = envUrl.replace(/\/$/, '');
      const envOrigin = new URL(cleanUrl).origin;
      if (envOrigin !== window.location.origin && !cleanUrl.includes('localhost')) {
        return `${cleanUrl}/api/crm`;
      }
    } catch (_) {}
  }
  return '/api/crm';
}

const api = axios.create({
  baseURL: getApiBaseUrl(),
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true
});

// ─── Request interceptor ─────────────────────────────────────────────────────
api.interceptors.request.use(config => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[API] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
  }
  return config;
}, err => Promise.reject(err));

// ─── Response interceptor: role-aware auto-refresh on 401 ────────────────────
let isRefreshingAdmin = false;
let isRefreshingClient = false;
let adminFailedQueue = [];
let clientFailedQueue = [];

function processQueue(queue, error) {
  queue.forEach(p => error ? p.reject(error) : p.resolve());
  queue.length = 0;
}

function isAdminPath(url) {
  return !!(url && (url.includes('/admin') || url.includes('/auth/admin')));
}

function isClientPath(url) {
  return !!(url && (url.includes('/client') || url.includes('/auth/client')));
}

api.interceptors.response.use(
  response => response,
  async error => {
    const original = error.config || {};
    const url = original.url || '';

    // ── SAFE failure diagnostics ─────────────────────────────────────────────
    // Surface the failing endpoint + HTTP status so a "Route not found" / load
    // failure is traceable. We log ONLY the method, the request PATH (query string
    // stripped) and the status + the server's machine error code/string. Request
    // and response bodies, headers, cookies, tokens and Authorization are NEVER
    // logged. 401s are skipped here because they are handled by the silent
    // token-refresh flow below (logging them would be misleading noise).
    if (error.response && error.response.status !== 401) {
      const method = String(original.method || 'get').toUpperCase();
      const path = String(url).split('?')[0];
      const status = error.response.status;
      const code = error.response.data?.code || error.response.data?.error || '';
      console.warn(`[API] ${method} ${path} → ${status}${code ? ` (${code})` : ''}`);
    } else if (error.request && !error.response) {
      const method = String(original.method || 'get').toUpperCase();
      console.warn(`[API] ${method} ${String(url).split('?')[0]} → no response (network/CORS/server down)`);
    }

    // Skip retry for login/refresh endpoints
    if (
      error.response?.status !== 401 ||
      original._retry ||
      url.includes('/auth/admin/refresh') ||
      url.includes('/auth/client/refresh') ||
      url.includes('/auth/refresh') ||
      url.includes('/auth/admin/login') ||
      url.includes('/auth/client/login')
    ) {
      return Promise.reject(error);
    }

    const adminPath = isAdminPath(url);
    const clientPath = isClientPath(url);

    // ── Admin path: use adminRefreshToken cookie ──────────────────────────
    if (adminPath) {
      if (isRefreshingAdmin) {
        return new Promise((resolve, reject) => {
          adminFailedQueue.push({ resolve, reject });
        }).then(() => api(original)).catch(err => Promise.reject(err));
      }
      original._retry = true;
      isRefreshingAdmin = true;
      try {
        await api.post('/auth/admin/refresh', {});
        processQueue(adminFailedQueue, null);
        return api(original);
      } catch (refreshError) {
        processQueue(adminFailedQueue, refreshError);
        localStorage.removeItem('genz_admin_user');
        window.location.href = '/admin/login';
        return Promise.reject(refreshError);
      } finally {
        isRefreshingAdmin = false;
      }
    }

    // ── Client path: use clientRefreshToken cookie ────────────────────────
    if (clientPath) {
      if (isRefreshingClient) {
        return new Promise((resolve, reject) => {
          clientFailedQueue.push({ resolve, reject });
        }).then(() => api(original)).catch(err => Promise.reject(err));
      }
      original._retry = true;
      isRefreshingClient = true;
      try {
        await api.post('/auth/client/refresh', {});
        processQueue(clientFailedQueue, null);
        return api(original);
      } catch (refreshError) {
        processQueue(clientFailedQueue, refreshError);
        localStorage.removeItem('genz_client_user');
        window.location.href = '/client/login';
        return Promise.reject(refreshError);
      } finally {
        isRefreshingClient = false;
      }
    }

    // ── Generic fallback (extension, public, other routes) ────────────────
    original._retry = true;
    try {
      await api.post('/auth/refresh', {});
      return api(original);
    } catch (refreshError) {
      const path = window.location.pathname;
      if (path.startsWith('/admin')) {
        localStorage.removeItem('genz_admin_user');
        window.location.href = '/admin/login';
      } else {
        localStorage.removeItem('genz_client_user');
        window.location.href = '/client/login';
      }
      return Promise.reject(refreshError);
    }
  }
);

export default api;
