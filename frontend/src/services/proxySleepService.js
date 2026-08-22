// Proxy Services SLEEP/WAKE API service (isolated).
//
// Sleeping a proxy unmounts its Passenger Node app so the vhost answers a static 503 and its
// workers exit — the files, database, DNS and SSL are all left untouched. Only four services
// exist server-side; the backend rejects anything else, so the id sent here is always one of
// them and is never used to build a path.
//
// Mutations are POST + CSRF, matching the launch/proxy-tools convention.
import api from './api';
import { withCsrfRetry } from './launchService';

export const proxySleepAdmin = {
  // Live state of all four services (real .htaccess + process state, not a stored flag).
  list: () => api.get('/admin/proxy-sleep'),

  sleep: (id) => withCsrfRetry((headers) =>
    api.post(`/admin/proxy-sleep/${id}/sleep`, {}, { headers })),

  wake: (id) => withCsrfRetry((headers) =>
    api.post(`/admin/proxy-sleep/${id}/wake`, {}, { headers })),
};

export default proxySleepAdmin;
