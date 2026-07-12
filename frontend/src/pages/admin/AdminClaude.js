import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import AdminProxyTools from './AdminProxyTools';
import { Bot } from 'lucide-react';

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
 *
 * Theme note: this content sits on the dark navy dashboard canvas, so bare text uses the
 * brand classes (text-genz-navy / text-genz-muted) which dashboard.css remaps to light —
 * raw Tailwind text-slate-* is NOT remapped and would render dark-on-navy (faint).
 */
const AdminClaude = () => (
  <AdminLayoutEnhanced>
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header — brand classes so it reads clearly (light) on the navy canvas */}
      <div className="flex items-center gap-4">
        <span className="w-12 h-12 rounded-2xl flex items-center justify-center text-white bg-gradient-to-br from-orange-500 to-amber-600 shadow-lg shadow-orange-500/20 flex-shrink-0">
          <Bot size={24} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="font-heading text-2xl font-extrabold text-genz-navy leading-none">Claude AI</h1>
            <span className="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-300 border border-orange-400/30">
              Isolated proxy tool
            </span>
          </div>
          <p className="text-sm text-genz-muted mt-1.5">
            Manage the Claude (claude.ai) account vault, client access and session length. Fully separate from every other tool.
          </p>
        </div>
      </div>

      {/* Full Claude management — account vault + client assignment. Reuses the Proxy-Tools
          management UI locked to Claude (embedded, no extra layout/header), reading/writing the
          SAME MySQL ProxyAccount vault + ProxyClient assignments. Single source of truth. */}
      <div className="pt-2 border-t border-white/10">
        <AdminProxyTools fixedTool="claude" embedded />
      </div>
    </div>
  </AdminLayoutEnhanced>
);

export default AdminClaude;
