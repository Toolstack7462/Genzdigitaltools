import api from '../../services/api';
let csrfToken = '';
export function setBusinessCsrf(value) { csrfToken = String(value || ''); }
export function getBusinessCsrf() { return csrfToken; }
function config(extra = {}) {
  const headers = { ...(extra.headers || {}) };
  if (csrfToken) headers['x-business-csrf-token'] = csrfToken;
  return { ...extra, headers };
}
export const crmApi = {
  bootstrap: () => api.get('/admin/business/bootstrap'),
  get: (path, options) => api.get(`/admin/business${path}`, config(options)),
  post: (path, data, options) => api.post(`/admin/business${path}`, data, config(options)),
  put: (path, data, options) => api.put(`/admin/business${path}`, data, config(options)),
  patch: (path, data, options) => api.patch(`/admin/business${path}`, data, config(options)),
  delete: (path, options) => api.delete(`/admin/business${path}`, config(options)),
  rawUrl: (path) => `${api.defaults.baseURL || '/api/crm'}/admin/business${path}`,
};
export function messageFromError(error) {
  const data = error?.response?.data;
  if (Array.isArray(data?.details)) return data.details.map((x) => x.message).join(' • ');
  return data?.error || error?.message || 'Request failed';
}
