import { useState, useEffect, useCallback } from 'react';
import ClientLayoutEnhanced from '../../components/ClientLayoutEnhanced';
import {
  Sparkles, ShieldCheck, Clock, ExternalLink, AlertTriangle,
  Gauge, ScanSearch, Loader2, RefreshCw, Lock
} from 'lucide-react';
import { stealthClient } from '../../services/stealthService';
import { useToast } from '../../components/Toast';

const fmtLimit = (used, remaining, limit) => {
  if (limit < 0) return `${used} used · Unlimited`;
  return `${used} / ${limit} used · ${remaining} left`;
};
const fmtDate = (d) => {
  if (!d) return 'No expiry';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? 'No expiry' : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const LimitCard = ({ icon: Icon, title, used, remaining, limit, accent }) => {
  const unlimited = limit < 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const exhausted = !unlimited && remaining <= 0;
  return (
    <div className="gz-card rounded-xl p-4" style={{ background: 'linear-gradient(167deg,#ffffff 0%,#f6fbfe 100%)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-white bg-gradient-to-br ${accent}`}>
          <Icon size={16} />
        </span>
        <span className="font-semibold text-slate-700 text-sm">{title}</span>
      </div>
      <p className="text-[13px] text-slate-600 mb-2">{fmtLimit(used, remaining, limit)}</p>
      {!unlimited && (
        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full ${exhausted ? 'bg-red-500' : 'bg-gradient-to-r from-blue-500 to-cyan-400'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {exhausted && <p className="text-[11px] text-red-600 font-semibold mt-1.5">Daily limit reached</p>}
    </div>
  );
};

const ClientStealthWriter = () => {
  const { showError } = useToast();
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await stealthClient.getDashboard();
      setData(res.data);
    } catch (e) {
      showError(e.response?.data?.error || 'Failed to load StealthWriter');
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => { load(); }, [load]);

  const handleOpen = async () => {
    try {
      setOpening(true);
      const res = await stealthClient.open();
      if (res.data?.url) {
        window.open(res.data.url, '_blank', 'noopener');
        load(); // refresh remaining/lease info
      }
    } catch (e) {
      showError(e.response?.data?.error || 'Unable to open StealthWriter');
    } finally {
      setOpening(false);
    }
  };

  const plan = data?.plan;
  const active = plan?.active;

  return (
    <ClientLayoutEnhanced>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-5">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white bg-gradient-to-br from-violet-500 to-fuchsia-500">
            <Sparkles size={22} />
          </span>
          <div>
            <h1 className="font-heading text-xl font-bold text-slate-800">StealthWriter</h1>
            <p className="text-sm text-slate-500">Humanize text and run AI detection inside a secure 30-minute session.</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="animate-spin mr-2" size={20} /> Loading…</div>
        ) : !data?.hasPlan ? (
          <div className="gz-card rounded-xl p-8 text-center">
            <Lock className="mx-auto mb-3 text-slate-400" size={28} />
            <h2 className="font-semibold text-slate-700 mb-1">No StealthWriter plan</h2>
            <p className="text-sm text-slate-500">You don't have a StealthWriter plan yet. Contact support to get access.</p>
          </div>
        ) : (
          <>
            {/* Plan summary */}
            <div className="gz-card rounded-xl p-5 mb-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-800">{plan.planName}</span>
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {plan.expired ? 'Expired' : (active ? 'Active' : 'Disabled')}
                    </span>
                  </div>
                  <p className="text-[13px] text-slate-500 mt-1 flex items-center gap-1.5">
                    <ShieldCheck size={13} /> Expiry: {fmtDate(plan.expiryDate)}
                  </p>
                </div>
                <button onClick={load} className="text-slate-400 hover:text-slate-600" title="Refresh"><RefreshCw size={16} /></button>
              </div>
            </div>

            {/* Limits */}
            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              <LimitCard icon={Gauge} title="Humanizer" accent="from-blue-500 to-cyan-500"
                used={plan.used.humanizer} remaining={plan.remaining.humanizer} limit={plan.limits.humanizer} />
              <LimitCard icon={ScanSearch} title="AI Detector" accent="from-violet-500 to-fuchsia-500"
                used={plan.used.detector} remaining={plan.remaining.detector} limit={plan.limits.detector} />
            </div>

            {/* Reset note */}
            <div className="flex items-center gap-2 text-[13px] text-slate-500 mb-5">
              <Clock size={14} /> Limits reset daily at <b className="text-slate-700">{data.resetLabel || '5:00 AM Pakistan Time'}</b>.
            </div>

            {/* Open button */}
            {!active ? (
              <div className="flex items-center gap-2 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
                <AlertTriangle size={16} />
                {plan.expired ? 'Your plan has expired. Contact support to renew.' : 'Your access is currently disabled.'}
              </div>
            ) : (
              <button onClick={handleOpen} disabled={opening}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-600 to-cyan-500 hover:opacity-95 disabled:opacity-60 transition shadow-lg shadow-cyan-500/20">
                {opening ? <Loader2 className="animate-spin" size={18} /> : <ExternalLink size={18} />}
                {opening ? 'Opening…' : 'Open StealthWriter'}
              </button>
            )}
            <p className="text-[12px] text-slate-400 mt-3">
              A secure 30-minute session opens in a new tab. Usage is counted in real time and enforced by Gen Z Digital Store.
            </p>
          </>
        )}
      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientStealthWriter;
