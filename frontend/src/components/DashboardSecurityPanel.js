import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldCheck, ShieldAlert, Clock, Smartphone, Lock, ArrowRight, MapPin,
} from 'lucide-react';
import api from '../services/api';

/* ─── DashboardSecurityPanel ──────────────────────────────────────────────────
   At-a-glance account security for the signed-in client. Reuses EXISTING data via
   the small GET /client/security endpoint (last sign-in, device-approval status,
   and recent failed/blocked sign-in attempts) — no new tracking, no secrets, only
   the client's own metadata. Fetched independently after the dashboard renders, so
   it never blocks tool launch; fully fail-safe (errors collapse to a calm "secured"
   state). The red strip ("Failed Login Alerts") only appears when there were real
   failed/blocked attempts in the last 7 days, so it informs without nagging. */

function fmtWhen(d) {
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  const diff = Date.now() - dt.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function Row({ icon: Icon, iconBg, iconTone, label, value, valueNode, hint }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
        <Icon size={14} className={iconTone} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-genz-muted leading-none">{label}</p>
        <div className="text-[12.5px] font-semibold text-genz-navy mt-1 truncate">
          {valueNode || value || '—'}
        </div>
      </div>
      {hint && <span className="text-[11px] text-genz-muted flex-shrink-0">{hint}</span>}
    </div>
  );
}

const DashboardSecurityPanel = () => {
  const [sec, setSec] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/client/security');
      setSec(res.data?.security || null);
    } catch (_) {
      setSec(null); // fail-safe: render the calm secured fallback
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const failed = sec?.failedRecent || 0;
  const dsum = sec?.deviceSummary || { total: 0, approved: 0, pending: 0, blocked: 0 };
  const pending = dsum.pending || 0;
  const lastLogin = sec?.lastLogin || null;
  const bindingOn = !!sec?.deviceBinding?.enabled;

  const deviceValue = dsum.total > 0
    ? `${dsum.total} device${dsum.total > 1 ? 's' : ''}${dsum.approved ? ` · ${dsum.approved} approved` : ''}`
    : 'No devices recorded yet';

  return (
    <div className="ds-card p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13.5px] font-bold text-genz-navy flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg flex items-center justify-center text-white flex-shrink-0"
                style={{ background: failed > 0 ? 'linear-gradient(135deg,#ef4444,#b91c1c)' : 'linear-gradient(135deg,#0891B2,#14B8A6)' }}>
            {failed > 0 ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
          </span>
          Security
        </h3>
        {failed > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-700">
            {failed} alert{failed > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2.5" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 animate-pulse">
              <div className="w-8 h-8 rounded-lg bg-genz-navy/10 flex-shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-2 w-16 rounded bg-genz-navy/10" />
                <div className="h-2.5 w-2/3 rounded bg-genz-navy/10" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Failed Login Alerts — only when there were real recent attempts. */}
          {failed > 0 && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 mb-2">
              <ShieldAlert size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-[12px] text-red-700 leading-snug">
                <span className="font-bold">{failed} failed or blocked sign-in attempt{failed > 1 ? 's' : ''}</span> in the last 7 days.
                If this wasn't you, change your password and contact support.
              </p>
            </div>
          )}

          <div className="divide-y divide-genz-border">
            <Row
              icon={Clock} iconBg="bg-green-50" iconTone="text-green-600"
              label="Last sign-in"
              valueNode={lastLogin
                ? (<span className="inline-flex items-center gap-1.5">
                     {fmtWhen(lastLogin.at)}
                     {lastLogin.ip && (
                       <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-genz-muted">
                         <MapPin size={10} /> {lastLogin.ip}
                       </span>
                     )}
                   </span>)
                : 'This session'}
            />
            <Row
              icon={Smartphone}
              iconBg={pending > 0 ? 'bg-amber-50' : 'bg-cyan-50'}
              iconTone={pending > 0 ? 'text-amber-600' : 'text-cyan-600'}
              label="Devices"
              value={deviceValue}
              hint={pending > 0 ? `${pending} pending` : undefined}
            />
            <Row
              icon={Lock}
              iconBg={bindingOn ? 'bg-cyan-50' : 'bg-genz-bg'}
              iconTone={bindingOn ? 'text-cyan-600' : 'text-genz-muted'}
              label="Device binding"
              valueNode={bindingOn
                ? <span className="text-emerald-600">On · access locked to approved devices</span>
                : <span className="text-genz-muted">Off</span>}
            />
          </div>

          <Link to="/client/profile"
                className="mt-3 inline-flex items-center justify-center gap-1.5 w-full py-2 rounded-lg text-[12.5px] font-semibold border border-genz-border text-genz-navy hover:border-genz-blue/40 hover:text-genz-blue transition-all">
            Manage security <ArrowRight size={13} />
          </Link>
        </>
      )}
    </div>
  );
};

export default DashboardSecurityPanel;
