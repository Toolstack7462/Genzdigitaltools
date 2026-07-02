// WriteHuman V2 monitoring API service (isolated). Talks to the Genz CRM backend, which proxies
// to the standalone V2 service — the browser never holds the V2 admin key. Mirrors the shape of
// the other admin services (uses the shared `api` client: baseURL + admin cookie + auto-refresh).
import api from './api';

export const writeHumanV2Admin = {
  getState: () => api.get('/admin/writehuman-v2/state'),
  getLogs: (limit = 120) => api.get(`/admin/writehuman-v2/logs?limit=${limit}`),
  health: () => api.get('/admin/writehuman-v2/health'),
  verify: () => api.post('/admin/writehuman-v2/verify'),
  command: (command) => api.post('/admin/writehuman-v2/command', { command }),
};
