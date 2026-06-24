import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity as ActivityIcon, LogIn, ShieldAlert, Smartphone, Package, ArrowRight,
} from 'lucide-react';
import api from '../services/api';

/* ─── DashboardActivityPreview ────────────────────────────────────────────────
   A compact "recent activity" card for the dashboard. It REUSES the existing
   GET /client/activity endpoint (the same data the full /client/activity page
   shows) — no new API, no new tracking. Fetched independently after the dashboard
   has already rendered, so it never blocks the tools/launch path; it is fully
   fail-safe (a failed/empty fetch just shows a calm empty state, never an error
   that disrupts the dashboard). Shows the 5 most recent events with a link to the
   full timeline. */

// Friendly label + icon for one activity entry (mirrors the full Activity page).
function describe(a) {
  const ac = String(a.action || '').toUpperCase();
  if (ac.includes('LOGIN') && (ac.includes('FAIL') || ac.includes('BLOCK')))
    return { Icon: ShieldAlert, tone: 'text-amber-500', bg: 'bg-amber-50', text: 'Blocked or failed sign-in' };
  if (ac.includes('LOGIN'))
    return { Icon: LogIn, tone: 'text-green-600', bg: 'bg-green-50', text: 'Signed in to your account' };
  if (ac.includes('DEVICE'))
    return { Icon: Smartphone, tone: 'text-cyan-600', bg: 'bg-cyan-50', text: ac.includes('RESET') ? 'Device binding reset' : 'Device updated' };
  if (ac.includes('TOOL_OPEN') || ac.includes('TOOL_ACCESS') || ac.includes('LEASE'))
    return { Icon: Package, tone: 'text-genz-blue', bg: 'bg-blue-50', text: `Opened ${a.toolName || 'a tool'}` };
  return { Icon: ActivityIcon, tone: 'text-genz-muted', bg: 'bg-genz-bg', text: String(ac).replace(/_/g, ' ').toLowerCase() };
}

// Lightweight relative time ("2m ago", "3h ago", "Yesterday", date).
function timeAgo(d) {
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
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const DashboardActivityPreview = () => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/client/activity?limit=8&days=30');
      setItems(Array.isArray(res.data?.activity) ? res.data.activity.slice(0, 5) : []);
    } catch (_) {
      setItems([]); // fail-safe: never disrupt the dashboard
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="ds-card p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13.5px] font-bold text-genz-navy flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg flex items-center justify-center text-white flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
            <ActivityIcon size={14} />
          </span>
          Recent Activity
        </h3>
        <Link to="/client/activity"
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-genz-blue hover:gap-1.5 transition-all">
          View all <ArrowRight size={12} />
        </Link>
      </div>

      {loading ? (
        <div className="space-y-2.5" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 animate-pulse">
              <div className="w-8 h-8 rounded-lg bg-genz-navy/10 flex-shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-2.5 w-1/2 rounded bg-genz-navy/10" />
                <div className="h-2 w-20 rounded bg-genz-navy/10" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
          <div className="w-11 h-11 rounded-xl bg-genz-bg flex items-center justify-center mb-2.5">
            <ActivityIcon size={20} className="text-genz-muted" />
          </div>
          <p className="text-[13px] font-semibold text-genz-navy">No recent activity</p>
          <p className="text-[11.5px] text-genz-muted mt-0.5">Your sign-ins and tool opens will appear here.</p>
        </div>
      ) : (
        <ol className="space-y-1">
          {items.map((a) => {
            const { Icon, tone, bg, text } = describe(a);
            return (
              <li key={a._id} className="flex items-center gap-2.5 py-1.5">
                <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${bg}`}>
                  <Icon size={14} className={tone} />
                </span>
                <span className="flex-1 min-w-0 text-[12.5px] font-medium text-genz-navy truncate">{text}</span>
                <span className="text-[11px] text-genz-muted flex-shrink-0 tabular-nums">{timeAgo(a.createdAt)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};

export default DashboardActivityPreview;
