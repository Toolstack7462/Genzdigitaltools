// Proxy-Tools (HIX AI / BypassGPT) API service (isolated). Talks to the Genz CRM backend.
import api from './api';

// ── Admin (per tool) ────────────────────────────────────────────────────────
export const proxyToolsAdmin = {
  listTools: () => api.get('/admin/proxy-tools/tools'),
  getStats: (tool) => api.get(`/admin/proxy-tools/${tool}/stats`),

  // Lightweight, server-side-searched source for the "Grant access" picker
  // (minimal fields, ranked + paginated, eligible-only). Additive — the existing
  // listClients (granted list) is unchanged.
  assignableClients: (tool, params = {}) => api.get(`/admin/proxy-tools/${tool}/assignable-clients?${new URLSearchParams(params)}`),

  // Client access grants
  listClients: (tool, params = {}) => api.get(`/admin/proxy-tools/${tool}/clients?${new URLSearchParams(params)}`),
  createClient: (tool, body) => api.post(`/admin/proxy-tools/${tool}/clients`, body),
  updateClient: (tool, id, body) => api.put(`/admin/proxy-tools/${tool}/clients/${id}`, body),
  deleteClient: (tool, id) => api.delete(`/admin/proxy-tools/${tool}/clients/${id}`),
  revokeClientLeases: (tool, id) => api.post(`/admin/proxy-tools/${tool}/clients/${id}/revoke-leases`),
  revokeLease: (tool, leaseId) => api.post(`/admin/proxy-tools/${tool}/leases/${leaseId}/revoke`),

  // Account Vault
  listAccounts: (tool) => api.get(`/admin/proxy-tools/${tool}/accounts`),
  createAccount: (tool, body) => api.post(`/admin/proxy-tools/${tool}/accounts`, body),
  updateAccount: (tool, id, body) => api.put(`/admin/proxy-tools/${tool}/accounts/${id}`, body),
  refreshAccountSession: (tool, id, sessionBundle) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/session`, { sessionBundle }),
  verifyAccount: (tool, id) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/verify`),
  accountLeases: (tool, id) => api.get(`/admin/proxy-tools/${tool}/accounts/${id}/leases`),
  captureLease: (tool, id, headers = {}) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/capture-lease`, {}, { headers }),
  setAccountPrimary: (tool, id) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/primary`),
  setAccountStatus: (tool, id, status) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/status`, { status }),
  revokeAccountLeases: (tool, id) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/revoke-leases`),
  deleteAccount: (tool, id) => api.delete(`/admin/proxy-tools/${tool}/accounts/${id}`),
  // Tool-wide: revoke ALL active leases so the next launch reads the latest cookies.
  refreshSessions: (tool) => api.post(`/admin/proxy-tools/${tool}/refresh-sessions`),
  // Ground-truth: which account clients get now + a safe live probe of its session.
  activeAccount: (tool) => api.get(`/admin/proxy-tools/${tool}/active-account`),
  // Claude token-quota (claude-only): global config + one client's live estimated usage.
  quotaConfig: (tool) => api.get(`/admin/proxy-tools/${tool}/quota-config`),
  clientQuota: (tool, id) => api.get(`/admin/proxy-tools/${tool}/clients/${id}/quota`),
  // Claude usage management (claude-only): dashboard, per-client history, editable globals.
  // `q` searches client name / email / assigned account label (server-side, case-insensitive,
  // partial). Paginated server-side so the full client list is never sent to the browser.
  // Signature stays backwards-compatible: usageDashboard('claude') behaves as before, page 1.
  usageDashboard: (tool, { q = '', page = 1, limit } = {}) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (page && page > 1) p.set('page', String(page));
    if (limit) p.set('limit', String(limit));
    const qs = p.toString();
    return api.get(`/admin/proxy-tools/${tool}/usage-dashboard${qs ? `?${qs}` : ''}`);
  },
  usageHistory: (tool, id, limit = 25) => api.get(`/admin/proxy-tools/${tool}/clients/${id}/usage-history?limit=${limit}`),
  getGlobalConfig: (tool) => api.get(`/admin/proxy-tools/${tool}/global-config`),
  setGlobalConfig: (tool, body) => api.put(`/admin/proxy-tools/${tool}/global-config`, body),
};

// ── Client ────────────────────────────────────────────────────────────────
export const proxyToolsClient = {
  list: () => api.get('/client/proxy-tools'),
  // `headers` carries the launch CSRF token (see services/launchService.js). Callers should
  // go through withCsrfRetry() so an aged-out token is refetched instead of failing the click.
  open: (tool, headers = {}) => api.post(`/client/proxy-tools/${tool}/open`, {}, { headers }),
};
