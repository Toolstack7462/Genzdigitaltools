import { useState, useEffect } from 'react';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import { Package, CheckCircle2, Boxes, Puzzle, Globe, ClipboardList, Clock, XCircle, Users, BarChart3, RefreshCw } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const AdminAnalytics = () => {
  const { showError } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const load = async () => {
    try {
      setLoading(true);
      const res = await api.get('/admin/analytics');
      setData(res.data || null);
    } catch {
      showError('Failed to load analytics');
    } finally {
      setLoading(false);
    }
  };

  const s = data?.stats || {};
  const statCards = data ? [
    { icon: Package,       label: 'Total Tools',         value: s.totalTools ?? 0,         hex: '#06B6D4' },
    { icon: CheckCircle2,  label: 'Active Tools',        value: s.activeTools ?? 0,        hex: '#16A34A' },
    { icon: Puzzle,        label: 'Extension Tools',     value: s.extensionTools ?? 0,     hex: '#2563EB' },
    { icon: Boxes,         label: 'Proxy Tools',         value: s.proxyTools ?? 0,         hex: '#7C3AED' },
    { icon: ClipboardList, label: 'Total Assignments',   value: s.totalAssignments ?? 0,   hex: '#0EA5E9' },
    { icon: CheckCircle2,  label: 'Active Assignments',  value: s.activeAssignments ?? 0,  hex: '#16A34A' },
    { icon: XCircle,       label: 'Expired Assignments', value: s.expiredAssignments ?? 0, hex: '#DC2626' },
    { icon: Users,         label: 'Active Clients',      value: s.activeClients ?? 0,      hex: '#D97706' },
  ] : [];

  if (loading) {
    return (
      <AdminLayoutEnhanced>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={`${ADMIN_CARD_VARIANTS.default} p-4 pt-[18px] rounded-xl animate-pulse`}>
              <div className="w-10 h-10 rounded-xl bg-genz-bg mb-3" />
              <div className="h-7 w-12 rounded bg-genz-bg" />
              <div className="h-3 w-20 rounded bg-genz-bg mt-1.5" />
            </div>
          ))}
        </div>
      </AdminLayoutEnhanced>
    );
  }

  return (
    <AdminLayoutEnhanced>
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-black text-genz-navy">Analytics</h1>
            <p className="text-genz-muted text-[13px]">Live overview of tools, assignments, clients and activity</p>
          </div>
          <button onClick={load}
                  className="p-2 rounded-xl border border-genz-border text-genz-muted hover:text-genz-teal hover:border-genz-teal/30 transition-all"
                  aria-label="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {statCards.map(({ icon: Icon, label, value, hex }) => (
            <div key={label} className={`${ADMIN_CARD_VARIANTS.default} ds-stat relative overflow-hidden p-4 pt-[18px] rounded-xl`}>
              <span className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${hex}, ${hex}66)` }} />
              <span className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
                    style={{ background: `${hex}14`, color: hex, border: `1px solid ${hex}26` }}>
                <Icon size={18} />
              </span>
              <div className="text-[28px] font-extrabold text-genz-navy tabular-nums leading-none">{value}</div>
              <div className="text-[12px] font-medium text-genz-muted mt-1.5">{label}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Top Tools */}
          <div className={`${ADMIN_CARD_VARIANTS.default} p-4 rounded-2xl`}>
            <h2 className="text-[15px] font-bold text-genz-navy mb-3 flex items-center gap-2">
              <BarChart3 size={16} className="text-genz-teal" /> Top Accessed Tools
            </h2>
            {data?.topTools?.length ? (
              <div className="space-y-2">
                {data.topTools.map(({ name, count }) => {
                  const maxCount = data.topTools[0]?.count || 1;
                  const pct = Math.round((count / maxCount) * 100);
                  return (
                    <div key={name}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-genz-muted truncate">{name}</span>
                        <span className="text-genz-teal font-mono text-xs ml-2">{count}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-genz-bg overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-500"
                             style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#06B6D4,#0891B2)' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className="text-sm text-genz-muted">No tool opens recorded recently.</p>}
          </div>

          {/* Recent Activity */}
          <div className={`${ADMIN_CARD_VARIANTS.default} p-4 rounded-2xl`}>
            <h2 className="text-[15px] font-bold text-genz-navy mb-3 flex items-center gap-2">
              <Clock size={16} className="text-genz-teal" /> Recent Activity
            </h2>
            <div className="space-y-1.5">
              {data?.recentActivity?.length ? data.recentActivity.map((log) => (
                <div key={log._id} className="flex items-center gap-3 p-2 rounded-lg bg-white text-[13px]">
                  <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-genz-teal" />
                  <span className="text-genz-muted w-36 flex-shrink-0 text-xs font-mono">
                    {new Date(log.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-genz-muted flex-1 truncate">{(log.action || '').replace(/_/g, ' ')}</span>
                  <span className="text-genz-muted text-xs">{log.actorRole}</span>
                </div>
              )) : <p className="text-sm text-genz-muted">No recent activity.</p>}
            </div>
          </div>
        </div>
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminAnalytics;
