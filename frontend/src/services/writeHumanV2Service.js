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
};
