import { useState, useEffect, useCallback } from 'react';
import ClientLayoutEnhanced from '../../components/ClientLayoutEnhanced';
import {
  Activity as ActivityIcon, Clock, LogIn, ShieldAlert, ShieldOff, Smartphone,
  Package, CheckCircle2, RefreshCw, AlertCircle,
} from 'lucide-react';
import api from '../../services/api';

// Friendly label + icon for one of the client's OWN activity entries.
function describe(a) {
  const ac = String(a.action || '').toUpperCase();
  if (ac.includes('LOGIN') && (ac.includes('FAIL') || ac.includes('BLOCK')))
    return { Icon: ShieldAlert, tone: 'text-amber-500', bg: 'bg-amber-50', text: 'Blocked or failed sign-in' };
  if (ac.includes('LOGIN'))
    return { Icon: LogIn, tone: 'text-green-600', bg: 'bg-green-50', text: 'Signed in to your account' };
  if (ac.includes('DEVICE_RESET'))
    return { Icon: Smartphone, tone: 'text-cyan-600', bg: 'bg-cyan-50', text: 'Device binding reset' };
  if (ac.includes('DEVICE'))
    return { Icon: ShieldOff, tone: 'text-cyan-600', bg: 'bg-cyan-50', text: 'Device updated' };
  if (ac.includes('TOOL_OPEN') || ac.includes('TOOL_ACCESS') || ac.includes('LEASE'))
    return { Icon: Package, tone: 'text-genz-blue', bg: 'bg-blue-50', text: `Opened ${a.toolName || 'a tool'}` };
  return { Icon: ActivityIcon, tone: 'text-genz-muted', bg: 'bg-genz-bg', text: ac.replace(/_/g, ' ').toLowerCase() };
}

const dayKey = (d) => { const dt = new Date(d); return isNaN(dt.getTime()) ? 'Earlier' : dt.toDateString(); };
function dayLabel(key) {
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 86400000).toDateString();
  if (key === today) return 'Today';
  if (key === yest) return 'Yesterday';
  if (key === 'Earlier') return 'Earlier';
  return new Date(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
const timeOf = (d) => { const dt = new Date(d); return isNaN(dt.getTime()) ? '' : dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

const ClientActivity = () => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true); setError(false);
      const res = await api.get('/client/activity?limit=100');
      setItems(Array.isArray(res.data?.activity) ? res.data.activity : []);
    } catch (_) { setError(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Group entries by calendar day, preserving recency order.
  const groups = [];
  const seen = {};
  items.forEach((a) => {
    const k = dayKey(a.createdAt);
    if (!seen[k]) { seen[k] = { key: k, rows: [] }; groups.push(seen[k]); }
    seen[k].rows.push(a);
  });

  return (
    <ClientLayoutEnhanced>
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-5">
          <div>
            <h1 className="font-heading text-2xl font-extrabold text-genz-navy flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white"
                    style={{ background: 'var(--gradient-cta)', boxShadow: '0 6px 14px -8px rgba(37,99,235,0.6)' }}>
                <ActivityIcon size={18} />
              </span>
              Activity
            </h1>
            <p className="text-sm text-genz-muted mt-0.5">Your recent sign-ins and tool usage.</p>
          </div>
          <button onClick={load}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-genz-border bg-white text-genz-navy text-sm font-medium hover:border-genz-teal/50 transition-colors"
            title="Refresh">
            <RefreshCw size={15} /> Refresh
          </button>
        </div>

        {loading ? (
          <div className="ds-card p-4 space-y-3" aria-busy="true">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 animate-pulse">
                <div className="w-9 h-9 rounded-lg bg-genz-navy/10 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/2 rounded bg-genz-navy/10" />
                  <div className="h-2.5 w-24 rounded bg-genz-navy/10" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="ds-card p-10 text-center">
            <AlertCircle size={28} className="mx-auto mb-3 text-genz-muted" />
            <p className="text-sm font-semibold text-genz-navy">Couldn't load your activity</p>
            <button onClick={load} className="text-xs text-genz-teal hover:underline mt-1.5">Try again</button>
          </div>
        ) : items.length === 0 ? (
          <div className="ds-card p-12 text-center">
            <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-blue-500/15 to-cyan-500/15 flex items-center justify-center">
              <Clock size={30} className="text-genz-muted" />
            </div>
            <h3 className="text-lg font-bold text-genz-navy mb-1.5">No activity yet</h3>
            <p className="text-sm text-genz-muted">Your sign-ins and tool opens will appear here.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(({ key, rows }) => (
              <div key={key}>
                <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-genz-muted mb-2.5 px-1">{dayLabel(key)}</h2>
                <div className="ds-card overflow-hidden">
                  <ol className="divide-y divide-genz-border">
                    {rows.map((a) => {
                      const { Icon, tone, bg, text } = describe(a);
                      return (
                        <li key={a._id} className="flex items-center gap-3.5 px-4 py-3 hover:bg-genz-bg/50 transition-colors">
                          <span className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${bg}`}>
                            <Icon size={16} className={tone} />
                          </span>
                          <span className="flex-1 min-w-0 text-sm font-medium text-genz-navy truncate">{text}</span>
                          <span className="text-xs text-genz-muted flex-shrink-0 tabular-nums">{timeOf(a.createdAt)}</span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientActivity;
