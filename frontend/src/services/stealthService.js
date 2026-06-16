// StealthWriter module API service (isolated). Talks to the Genz CRM backend.
import api from './api';

// ── Admin ─────────────────────────────────────────────────────────────────
export const stealthAdmin = {
  getSettings: () => api.get('/admin/stealth/settings'),
  updateSettings: (patch) => api.put('/admin/stealth/settings', patch),
  getStats: () => api.get('/admin/stealth/stats'),
  listClients: (params = {}) => api.get(`/admin/stealth/clients?${new URLSearchParams(params)}`),
  getClient: (id) => api.get(`/admin/stealth/clients/${id}`),
  createClient: (body) => api.post('/admin/stealth/clients', body),
  updateClient: (id, body) => api.put(`/admin/stealth/clients/${id}`, body),
  deleteClient: (id) => api.delete(`/admin/stealth/clients/${id}`),
  resetUsage: (id) => api.post(`/admin/stealth/clients/${id}/reset-usage`),
  revokeLeases: (id) => api.post(`/admin/stealth/clients/${id}/revoke-leases`),
  revokeLease: (leaseId) => api.post(`/admin/stealth/leases/${leaseId}/revoke`),

  // ── Account Vault ──────────────────────────────────────────────────────────
  listAccounts: () => api.get('/admin/stealth/accounts'),
  createAccount: (body) => api.post('/admin/stealth/accounts', body),
  updateAccount: (id, body) => api.put(`/admin/stealth/accounts/${id}`, body),
  refreshAccountSession: (id, sessionBundle) => api.post(`/admin/stealth/accounts/${id}/session`, { sessionBundle }),
  verifyAccount: (id) => api.post(`/admin/stealth/accounts/${id}/verify`),
  accountLeases: (id) => api.get(`/admin/stealth/accounts/${id}/leases`),
  captureLease: (id) => api.post(`/admin/stealth/accounts/${id}/capture-lease`),
  setAccountPrimary: (id) => api.post(`/admin/stealth/accounts/${id}/primary`),
  setAccountStatus: (id, status) => api.post(`/admin/stealth/accounts/${id}/status`, { status }),
  revokeAccountLeases: (id) => api.post(`/admin/stealth/accounts/${id}/revoke-leases`),
  deleteAccount: (id) => api.delete(`/admin/stealth/accounts/${id}`),
};

// ── Client ────────────────────────────────────────────────────────────────
export const stealthClient = {
  getDashboard: () => api.get('/client/stealth'),
  open: () => api.post('/client/stealth/open', {}),
};
