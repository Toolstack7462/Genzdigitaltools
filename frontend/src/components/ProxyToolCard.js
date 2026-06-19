import { useState } from 'react';
import { Zap, ShieldCheck, ExternalLink, Lock, AlertTriangle, Loader2 } from 'lucide-react';
import { proxyToolsClient } from '../services/proxyToolsService';
import { useToast } from './Toast';

/**
 * A proxy tool (HIX AI / BypassGPT) shown as a normal assigned-tool card on the
 * Dashboard / My Tools. Presentational + opens a 30-minute proxy session in a new
 * tab via /client/proxy-tools/:tool/open. No usage meters (these tools have none).
 *
 * Isolated from the regular tools list, the cookie/extension flow and StealthWriter.
 */
const fmtDate = (d) => {
  if (!d) return 'No expiry';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? 'No expiry' : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const THEME = {
  hix:       { from: 'from-sky-500',     to: 'to-cyan-500',    text: 'text-cyan-600',    grad: 'linear-gradient(135deg,#0ea5e9,#06b6d4)', soft: 'linear-gradient(167deg,#ffffff 0%,#f3fbff 100%)' },
  bypassgpt: { from: 'from-emerald-500', to: 'to-green-500',   text: 'text-emerald-600', grad: 'linear-gradient(135deg,#10b981,#22c55e)', soft: 'linear-gradient(167deg,#ffffff 0%,#f3fef8 100%)' },
};

const ProxyToolCard = ({ tool }) => {
  const { showError } = useToast();
  const [opening, setOpening] = useState(false);
  if (!tool) return null;

  const theme = THEME[tool.tool] || THEME.hix;
  const expired = !!tool.expired;
  const active = !!tool.active;
  const statusLabel = expired ? 'Expired' : (active ? 'Active' : 'Disabled');
  const statusColor = expired ? 'bg-red-100 text-red-700' : (active ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700');

  const handleOpen = async () => {
    try {
      setOpening(true);
      const res = await proxyToolsClient.open(tool.tool);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } catch (e) {
      showError(e.response?.data?.error || `Unable to open ${tool.name}`);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div
      className={`relative group rounded-xl p-4 flex flex-col transition-all duration-300 hover:-translate-y-1 ${
        expired ? 'opacity-80 border border-red-200 bg-red-50' : 'gz-card hover:shadow-[0_18px_38px_-18px_rgba(8,145,178,0.4)]'
      }`}
      style={!expired ? { background: theme.soft } : undefined}
      data-testid={`proxy-tool-card-${tool.tool}`}
    >
      <div className="flex items-start justify-between mb-2.5">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white bg-gradient-to-br ${theme.from} ${theme.to}`}>
          <Zap size={18} />
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${statusColor}`}>{statusLabel}</span>
      </div>

      <h3 className="font-bold text-genz-navy text-[15px] mb-0.5 truncate group-hover:text-genz-blue transition-colors">
        {tool.name}
      </h3>
      <p className={`text-[12px] font-semibold mb-2 ${theme.text}`}>{tool.tagline || 'AI Tool'}</p>

      <p className="text-[12px] text-genz-muted mb-3 flex items-center gap-1.5">
        <Lock size={12} /> Expiry: <span className="text-genz-navy font-semibold">{fmtDate(tool.expiryDate)}</span>
      </p>

      <div className="flex items-center gap-1.5 mb-3 text-[11.5px] text-genz-muted">
        <ShieldCheck size={12} className={theme.text} /> Secure 30-minute session
      </div>

      <div className="mt-auto pt-1">
        {expired || !active ? (
          <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[12px]">
            <AlertTriangle size={13} />
            {expired ? 'Access expired — contact support to renew.' : 'Access disabled — contact support.'}
          </div>
        ) : (
          <button
            onClick={handleOpen}
            disabled={opening}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12.5px] font-bold text-white transition-all hover:-translate-y-0.5 disabled:opacity-60"
            style={{ background: theme.grad, boxShadow: '0 8px 18px rgba(8,145,178,0.22)' }}
            data-testid={`open-proxy-tool-${tool.tool}`}
          >
            {opening ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
            {opening ? 'Opening…' : `Open ${tool.name}`}
          </button>
        )}
      </div>
    </div>
  );
};

export default ProxyToolCard;
