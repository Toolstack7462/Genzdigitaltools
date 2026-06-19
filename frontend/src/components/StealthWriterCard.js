import { useNavigate } from 'react-router-dom';
import { Sparkles, ExternalLink, Lock, AlertTriangle, Gauge, ScanSearch } from 'lucide-react';

/**
 * StealthWriter shown as a normal assigned-tool card on the Dashboard / My Tools.
 *
 * Presentational only — data comes from useStealthSummary(). The Open button routes
 * to the existing /client/stealthwriter page (the unchanged "Open StealthWriter"
 * flow). It never mints a lease, touches cookies, or mixes with the regular tools
 * list. Renders nothing when the client has no StealthWriter plan.
 */
const fmtDate = (d) => {
  if (!d) return 'No expiry';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? 'No expiry' : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const fmtLimit = (remaining, limit) => {
  if (limit < 0) return 'Unlimited';
  return `${remaining ?? 0} / ${limit} left`;
};

const StealthWriterCard = ({ stealth }) => {
  const navigate = useNavigate();
  if (!stealth || !stealth.hasPlan) return null;

  const plan = stealth.plan || {};
  const expired = !!plan.expired;
  const active = !!plan.active;
  const statusLabel = expired ? 'Expired' : (active ? 'Active' : 'Disabled');
  const statusColor = expired
    ? 'bg-red-100 text-red-700'
    : (active ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700');

  const limits = plan.limits || {};
  const remaining = plan.remaining || {};

  return (
    <div
      className={`relative group rounded-xl p-4 flex flex-col transition-all duration-300 hover:-translate-y-1 ${
        expired
          ? 'opacity-80 border border-red-200 bg-red-50'
          : 'gz-card hover:shadow-[0_18px_38px_-18px_rgba(124,58,237,0.45),0_0_0_1px_rgba(217,70,239,0.18)]'
      }`}
      style={!expired ? { background: 'linear-gradient(167deg,#ffffff 0%,#f7f5ff 100%)' } : undefined}
      data-testid="stealthwriter-card"
    >
      {/* header */}
      <div className="flex items-start justify-between mb-2.5">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white bg-gradient-to-br from-violet-500 to-fuchsia-500">
          <Sparkles size={18} />
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${statusColor}`}>
          {statusLabel}
        </span>
      </div>

      {/* name / category */}
      <h3 className="font-bold text-genz-navy text-[15px] mb-0.5 truncate group-hover:text-genz-blue transition-colors">
        StealthWriter
      </h3>
      <p className="text-[12px] font-semibold mb-2 text-fuchsia-600">{plan.planName || 'AI Humanizer & Detector'}</p>

      {/* expiry */}
      <p className="text-[12px] text-genz-muted mb-2.5 flex items-center gap-1.5">
        <Lock size={12} /> Expiry: <span className="text-genz-navy font-semibold">{fmtDate(plan.expiryDate)}</span>
      </p>

      {/* limits */}
      <div className="space-y-1.5 mb-3 p-2.5 bg-genz-bg rounded-lg border border-genz-border">
        <div className="flex items-center justify-between text-xs">
          <span className="text-genz-muted flex items-center gap-1"><Gauge size={12} /> Humanizer</span>
          <span className="text-genz-navy font-semibold">{fmtLimit(remaining.humanizer, limits.humanizer)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-genz-muted flex items-center gap-1"><ScanSearch size={12} /> AI Detector</span>
          <span className="text-genz-navy font-semibold">{fmtLimit(remaining.detector, limits.detector)}</span>
        </div>
      </div>

      {/* action */}
      <div className="mt-auto pt-2">
        {expired || !active ? (
          <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[12px]">
            <AlertTriangle size={13} />
            {expired ? 'Plan expired — contact support to renew.' : 'Access disabled — contact support.'}
          </div>
        ) : (
          <button
            onClick={() => navigate('/client/stealthwriter')}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12.5px] font-bold text-white transition-all hover:-translate-y-0.5"
            style={{ background: 'linear-gradient(135deg,#7C3AED,#D946EF)', boxShadow: '0 8px 18px rgba(124,58,237,0.22)' }}
            data-testid="open-stealthwriter-btn"
          >
            <ExternalLink size={13} /> Open StealthWriter
          </button>
        )}
      </div>
    </div>
  );
};

export default StealthWriterCard;
