import axios from 'axios';

function getApiBaseUrl() {
  const envUrl = process.env.REACT_APP_BACKEND_URL;
  if (envUrl) {
    try {
      const envOrigin = new URL(envUrl).origin;
      if (envOrigin !== window.location.origin && !envUrl.includes('localhost')) {
        return `${envUrl}/api/crm`;
      }
    } catch (_) {}
  }
  return '/api/crm';
}

const api = axios.create({
  baseURL: getApiBaseUrl(),
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true  // Send/receive httpOnly cookies on every request
});

// ─── Request interceptor ─────────────────────────────────────────────────────
api.interceptors.request.use(config => {
  // FIX1: No token from localStorage — auth is entirely cookie-based
  if (process.env.NODE_ENV === 'development') {
    console.log(`[API] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
  }
  return config;
}, err => Promise.reject(err));

// ─── Response interceptor: auto-refresh on 401 ───────────────────────────────
let isRefreshing = false;
let failedQueue = [];

function processQueue(error) {
  failedQueue.forEach(p => error ? p.reject(error) : p.resolve());
  failedQueue = [];
}

api.interceptors.response.use(
  response => response,
  async error => {
    const original = error.config;

    if (
      error.response?.status === 401 &&
      !original._retry &&
      !original.url?.includes('/auth/refresh') &&
      !original.url?.includes('/auth/admin/login') &&
      !original.url?.includes('/auth/client/login')
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(() => api(original)).catch(err => Promise.reject(err));
      }

      original._retry = true;
      isRefreshing = true;

      try {
        await api.post('/auth/refresh', {});
        processQueue(null);
        return api(original);
      } catch (refreshError) {
        processQueue(refreshError);
        localStorage.removeItem('crm_user');
        // Redirect to appropriate login
        const path = window.location.pathname;
        const loginPath = path.startsWith('/admin') ? '/admin/login' : '/client/login';
        window.location.href = loginPath;
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
