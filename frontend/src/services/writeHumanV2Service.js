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
  // "Verify now" reuses the existing per-account verify route (forceLive server-side).
  verify: (accountId) => api.post(`/admin/proxy-tools/${TOOL}/accounts/${accountId}/verify`),
  // Queue a remote command (relaunch-chrome / reverify) for the agent's next poll.
  command: (command) => api.post(`/admin/proxy-tools/${TOOL}/agent-command`, { command }),
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
  listEnrollments: () => api.get(`/admin/proxy-tools/${TOOL}/enrollments`),
  getEnrollment: (id) => api.get(`/admin/proxy-tools/${TOOL}/enrollments/${id}`),
  authorizeEnrollment: (id) => api.post(`/admin/proxy-tools/${TOOL}/enrollments/${id}/authorize`),
  // Queues a deliberate handover. The device becomes the active source on its next VERIFIED sync,
  // so an offline or signed-out machine can never become active in name only.
  makeActive: (deviceId) => api.post(`/admin/proxy-tools/${TOOL}/devices/${deviceId}/make-active`),
};
