// Proxy-Tools (HIX AI / BypassGPT) API service (isolated). Talks to the Genz CRM backend.
import api from './api';

// ── Admin (per tool) ────────────────────────────────────────────────────────
export const proxyToolsAdmin = {
  listTools: () => api.get('/admin/proxy-tools/tools'),
  getStats: (tool) => api.get(`/admin/proxy-tools/${tool}/stats`),

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
  captureLease: (tool, id) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/capture-lease`),
  setAccountPrimary: (tool, id) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/primary`),
  setAccountStatus: (tool, id, status) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/status`, { status }),
  revokeAccountLeases: (tool, id) => api.post(`/admin/proxy-tools/${tool}/accounts/${id}/revoke-leases`),
  deleteAccount: (tool, id) => api.delete(`/admin/proxy-tools/${tool}/accounts/${id}`),
};

// ── Client ────────────────────────────────────────────────────────────────
export const proxyToolsClient = {
  list: () => api.get('/client/proxy-tools'),
  open: (tool) => api.post(`/client/proxy-tools/${tool}/open`, {}),
};
