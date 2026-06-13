import { useState, useEffect } from 'react';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import { TrendingUp, CheckCircle2, XCircle, Clock, Zap, BarChart3, RefreshCw } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const AdminAnalytics = () => {
  const { showError } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('7d');

  useEffect(() => { load(); }, [period]);

  const load = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/admin/activity?limit=200`);
      const logs = res.data.logs || [];
      // Aggregate login success/failure from activity logs
      const stats = {
        totalLogins:    logs.filter(l => l.action === 'LOGIN' || l.action === 'TOOL_OPENED').length,
        successLogins:  logs.filter(l => l.action === 'LOGIN').length,
        toolOpens:      logs.filter(l => l.action === 'TOOL_OPENED').length,
        failures:       logs.filter(l => l.action === 'LOGIN_FAILED').length,
        tokenRefreshes: logs.filter(l => l.action === 'TOKEN_REFRESHED').length,
        logouts:        logs.filter(l => l.action === 'LOGOUT').length,
      };
      // Per-tool breakdown
      const toolMap = {};
      logs.filter(l => l.action === 'TOOL_OPENED').forEach(l => {
        const name = l.metadata?.toolName || l.metadata?.toolId || 'Unknown';
        toolMap[name] = (toolMap[name] || 0) + 1;
      });
      const topTools = Object.entries(toolMap)
        .sort(([,a],[,b]) => b - a)
        .slice(0, 8)
        .map(([name, count]) => ({ name, count }));
      setData({ stats, topTools, recentLogs: logs.slice(0, 20) });
    } catch {
      showError('Failed to load analytics');
    } finally {
      setLoading(false);
    }
  };

  const statCards = data ? [
    { icon: CheckCircle2, label: 'Successful Logins', value: data.stats.successLogins, color: 'text-green-500' },
    { icon: Zap,          label: 'Tool Opens',        value: data.stats.toolOpens,     color: 'text-genz-teal' },
    { icon: XCircle,      label: 'Login Failures',    value: data.stats.failures,      color: 'text-red-500'   },
    { icon: RefreshCw,    label: 'Token Refreshes',   value: data.stats.tokenRefreshes,color: 'text-yellow-500'},
  ] : [];

  if (loading) {
    return (
      <AdminLayoutEnhanced>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="w-10 h-10 rounded-full border-2 border-genz-teal border-t-transparent animate-spin" />
        </div>
      </AdminLayoutEnhanced>
    );
  }

  return (
    <AdminLayoutEnhanced>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-genz-navy">Login Analytics</h1>
            <p className="text-genz-muted text-sm">Tool access and login success/failure overview</p>
          </div>
          <button onClick={load}
                  className="p-2 rounded-xl border border-genz-border text-genz-muted hover:text-genz-teal hover:border-genz-teal/30 transition-all">
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map(({ icon: Icon, label, value, color }) => (
            <div key={label} className={`${ADMIN_CARD_VARIANTS.default} p-5 rounded-2xl`}>
              <Icon size={18} className={`${color} mb-3`} />
              <div className="text-2xl font-black text-genz-navy">{value}</div>
              <div className="text-xs text-genz-muted mt-0.5">{label}</div>
            </div>
          ))}
        </div>

        {/* Top Tools */}
        {data?.topTools?.length > 0 && (
          <div className={`${ADMIN_CARD_VARIANTS.default} p-5 rounded-2xl`}>
            <h2 className="font-bold text-genz-navy mb-4 flex items-center gap-2">
              <BarChart3 size={16} className="text-genz-teal" /> Top Accessed Tools
            </h2>
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
          </div>
        )}

        {/* Recent Activity */}
        <div className={`${ADMIN_CARD_VARIANTS.default} p-5 rounded-2xl`}>
          <h2 className="font-bold text-genz-navy mb-4">Recent Activity</h2>
          <div className="space-y-2">
            {data?.recentLogs?.map((log, i) => (
              <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-white text-sm">
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  log.action === 'LOGIN'        ? 'bg-green-500' :
                  log.action === 'LOGIN_FAILED' ? 'bg-red-500'   :
                  log.action === 'TOOL_OPENED'  ? 'bg-genz-teal' : 'bg-genz-muted'
                }`} />
                <span className="text-genz-muted w-36 flex-shrink-0 text-xs font-mono">
                  {new Date(log.createdAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}
                </span>
                <span className="text-genz-muted flex-1 truncate">{log.action}</span>
                <span className="text-genz-muted text-xs">{log.userRole}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminAnalytics;
