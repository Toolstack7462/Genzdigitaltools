import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import AdminProxyTools from './AdminProxyTools';
import { Bot, ShieldCheck, Clock, Lock } from 'lucide-react';

/**
 * Dedicated admin page for the Claude proxy tool (claude.ai).
 *
 * Claude is a normal, fully-isolated proxy tool — its own encrypted cookie vault
 * (ProxyAccount rows tagged tool='claude'), its own gateway subdomain
 * (claude1.genzdigitalstore.com) and its own client grants. Unlike WriteHuman it has NO
 * live RDP agent / cookie-sync telemetry, so this page is a clean branded wrapper around
 * the SAME generic Proxy-Tools management UI locked to Claude (embedded, no extra layout).
 * Account vault + client assignment read/write the one MySQL vault — single source of
 * truth, no separate store, no duplicate logic. Nothing here touches any other tool.
 */
const Info = ({ icon: Icon, title, children }) => (
  <div className="ds-card rounded-xl p-4 flex items-start gap-3">
    <span className="w-9 h-9 rounded-lg flex items-center justify-center text-white bg-gradient-to-br from-orange-500 to-amber-600 flex-shrink-0"><Icon size={16} /></span>
    <div><p className="text-sm font-semibold text-slate-700 leading-tight">{title}</p><p className="text-xs text-slate-500 mt-0.5">{children}</p></div>
  </div>
);

const AdminClaude = () => (
  <AdminLayoutEnhanced>
    <div className="flex items-center gap-3 mb-5">
      <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white bg-gradient-to-br from-orange-500 to-amber-600"><Bot size={22} /></span>
      <div>
        <h1 className="font-heading text-xl font-bold text-slate-800">Claude</h1>
        <p className="text-sm text-slate-500">Account vault, client access &amp; session length for the isolated Claude (claude.ai) proxy tool.</p>
      </div>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
      <Info icon={ShieldCheck} title="Server-side session">Vault account cookies are attached upstream only — never exposed to the client's browser. Identity, email, plan &amp; billing are hidden by the gateway.</Info>
      <Info icon={Clock} title="Timed access">Each Open mints a countdown lease (default 30 min). Set it per-client in Client Access, or globally via CLAUDE_LEASE_MINUTES.</Info>
      <Info icon={Lock} title="Fully isolated">Own subdomain, own encrypted vault (tool=claude), own leases &amp; grants. No shared logic with StealthWriter, WriteHuman or any other tool.</Info>
    </div>

    {/* Full Claude management — account vault + client assignment. Reuses the Proxy-Tools
        management UI locked to Claude (embedded, no extra layout/header), reading/writing the
        SAME MySQL ProxyAccount vault + ProxyClient assignments. Single source of truth. */}
    <AdminProxyTools fixedTool="claude" embedded />
  </AdminLayoutEnhanced>
);

export default AdminClaude;
