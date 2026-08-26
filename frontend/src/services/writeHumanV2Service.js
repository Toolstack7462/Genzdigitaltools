// WriteHuman admin monitoring API service.
//
// UNIFIED: reads/writes the SAME production proxy backend as the Proxy-Tools page (MySQL
// ProxyAccount vault + ProxyClient assignments) — a single source of truth. The RDP Cookie Sync
// Agent now writes fresh cookies into that same vault, so the dashboard, the account vault, and
// the client-facing gateway all reflect one state. No separate V2 store.
import api from './api';

const TOOL = 'writehuman';

export const writeHumanV2Admin = {
  // Aggregated live state (primary account session/verify/cookie-sync + agent telemetry).
  getState: () => api.get(`/admin/proxy-tools/${TOOL}/agent-state`),
  // Derived recent telemetry (sync / verify / agent report) for the live-log panel.
  getLogs: (limit = 120) => api.get(`/admin/proxy-tools/${TOOL}/agent-logs?limit=${limit}`),
  // VERIFY SESSION — entirely server-side. It reads the stored bundle, checks its cookies and
  // proves it with one real authenticated call. It does NOT open Chrome, does NOT start or message
  // an agent, does NOT pick a device, and works while the source machine is switched off.
  verifySession: () => api.post(`/admin/proxy-tools/${TOOL}/verify-session`, {}),
  // The per-account verify, kept for the embedded Proxy-Tools table.
  verify: (accountId) => api.post(`/admin/proxy-tools/${TOOL}/accounts/${accountId}/verify`),
  // OPEN WRITEHUMAN CHROME — the only action that launches a browser, and it goes to
  // `activeSourceId` and nowhere else. Never falls back to another device. CSRF-gated.
  openChromeOnActiveSource: (headers = {}, opts = {}) =>
    api.post(`/admin/proxy-tools/${TOOL}/open-chrome`, opts, { headers }),
  // Addressed agent command ('resync' | 'rotate-token'). Defaults to the ACTIVE SOURCE; a device
  // may be named explicitly. Browser-launching commands are refused here on purpose — they have
  // their own action, so a Chrome window can never open as a side effect of something else.
  command: (command, headers = {}, deviceId) =>
    api.post(`/admin/proxy-tools/${TOOL}/agent-command`, { command, deviceId }, { headers }),
  // Health-alert email (masked read; write to set/change/clear the recipient or toggle alerts).
  getAlertConfig: () => api.get(`/admin/proxy-tools/${TOOL}/alert-config`),
  setAlertConfig: (payload) => api.post(`/admin/proxy-tools/${TOOL}/alert-config`, payload),
  // Paired sync devices. Any paired machine may supply cookies; the newest VERIFIED bundle wins.
  getDevices: () => api.get(`/admin/proxy-tools/${TOOL}/devices`),
  // Returns a single-use pairing code — shown ONCE, never retrievable again.
  createPairCode: (name) => api.post(`/admin/proxy-tools/${TOOL}/devices/pair-code`, { name }),
  // Revokes a device's write access. Never deletes the stored cookie bundle.
  revokeDevice: (deviceId, force = false) => api.delete(`/admin/proxy-tools/${TOOL}/devices/${deviceId}${force ? '?force=1' : ''}`),
  // Browser-authorized agent enrolment. The credential is NEVER returned to the browser - the
  // agent collects it by polling with its PKCE verifier, so nothing secret crosses this boundary.
  // Installer build metadata (version, sha256, size) for the download button. Public route.
  getAgentBuild: () => api.get('/downloads/writehuman-agent/windows/latest.json'),
  listEnrollments: () => api.get(`/admin/proxy-tools/${TOOL}/enrollments`),
  getEnrollment: (id) => api.get(`/admin/proxy-tools/${TOOL}/enrollments/${id}`),
  // Takes headers so the caller can attach the CSRF token (see withCsrfRetry). The route is
  // requireCsrf-protected: it is a state change driven from a browser, which is exactly what
  // CSRF defends against - so the token is required, not optional.
  authorizeEnrollment: (id, headers = {}) => api.post(`/admin/proxy-tools/${TOOL}/enrollments/${id}/authorize`, {}, { headers }),
  // Queues a deliberate handover. The device becomes the active source on its next VERIFIED sync,
  // so an offline or signed-out machine can never become active in name only.
  makeActive: (deviceId) => api.post(`/admin/proxy-tools/${TOOL}/devices/${deviceId}/make-active`),
};
