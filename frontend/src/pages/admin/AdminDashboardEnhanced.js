import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import {
  Package, Users, TrendingUp, Activity as ActivityIcon,
  UserPlus, PackagePlus, Clock, CheckCircle2, AlertCircle,
  ArrowRight, Calendar, Sparkles, ShieldAlert, RefreshCw,
  Layers, Shield
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

/* ─────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────── */
function formatDate(date) {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60)    return 'Just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

function getActionIcon(action) {
  const a = String(action || '').toUpperCase();
  if (a.includes('LOGIN'))   return <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />;
  if (a.includes('CREAT'))   return <UserPlus      size={14} className="text-blue-500 flex-shrink-0" />;
  if (a.includes('DELET'))   return <AlertCircle   size={14} className="text-red-500 flex-shrink-0" />;
  if (a.includes('UPDAT') || a.includes('EDIT')) return <Clock size={14} className="text-yellow-500 flex-shrink-0" />;
  if (a.includes('ACCESS') || a.includes('OPEN')) return <Layers size={14} className="text-purple-500 flex-shrink-0" />;
  if (a.includes('DEVICE') || a.includes('BIND')) return <Shield size={14} className="text-cyan-500 flex-shrink-0" />;
  return <ActivityIcon size={14} className="text-genz-muted flex-shrink-0" />;
}

/* ─────────────────────────────────────────────────────────────────
   Skeleton loader
───────────────────────────────────────────────────────────────── */
function SkeletonCard() {
  return (
    <div className="rounded-2xl p-4 pt-[18px] border border-genz-border bg-white animate-pulse">
      <div className="flex items-center justify-between mb-3">
        <div className="w-10 h-10 rounded-xl bg-genz-bg" />
      </div>
      <div className="h-7 w-14 bg-genz-bg rounded mb-2" />
      <div className="h-3 w-20 bg-genz-bg rounded" />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Main component
───────────────────────────────────────────────────────────────── */
const AdminDashboardEnhanced = () => {
  const navigate = useNavigate();
  const { showError } = useToast();

  const [stats, setStats] = useState({
    totalTools: 0, activeTools: 0,
    totalClients: 0, activeClients: 0, disabledClients: 0,
    totalAssignments: 0, deviceBindings: 0,
  });
  const [recentActivity, setRecentActivity] = useState([]);
  const [recentClients, setRecentClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState(null);
  const [securityAlertCount, setSecurityAlertCount] = useState(0);

  useEffect(() => {
    loadDashboard();
    api.get('/admin/security-alerts?status=open&limit=1')
      .then(r => {
        const count = r.data?.stats?.highCount || r.data?.stats?.openCount || 0;
        if (count > 0) setSecurityAlertCount(count);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDashboard = async () => {
    setLoading(true);
    setDashboardError(null);
    try {
      const [toolsRes, clientsRes, clientStatsRes, activityRes] = await Promise.all([
        api.get('/admin/tools/stats').catch(() => ({ data: {} })),
        api.get('/admin/clients?limit=5').catch(() => ({ data: {} })),
        api.get('/admin/clients/stats').catch(() => ({ data: {} })),
        api.get('/admin/activity?limit=10').catch(() => ({ data: {} })),
      ]);

      const toolStats    = toolsRes.data?.stats       || {};
      const clientStats  = clientStatsRes.data?.stats  || {};
      const clients      = clientsRes.data?.clients    || [];
      const activities   = activityRes.data?.activities || [];

      const totalAssignments = Array.isArray(clients)
        ? clients.reduce((s, c) => s + (c?.assignmentCount || 0), 0)
        : 0;

      setStats({
        totalTools:       Number(toolStats.totalTools)      || 0,
        activeTools:      Number(toolStats.activeTools)     || 0,
        totalClients:     Number(clientStats.totalClients)  || 0,
        activeClients:    Number(clientStats.activeClients) || 0,
        disabledClients:  Number(clientStats.disabledClients) || 0,
        totalAssignments,
        // backend returns deviceLockedClients or clientsWithDeviceBinding
        deviceBindings:   Number(clientStats.deviceLockedClients || clientStats.clientsWithDeviceBinding) || 0,
      });

      setRecentClients(Array.isArray(clientStats.recentClients) ? clientStats.recentClients : []);
      setRecentActivity(Array.isArray(activities) ? activities : []);
    } catch (err) {
      console.error('Dashboard load error:', err);
      setDashboardError('Could not load dashboard data. Check your connection and try again.');
      showError('Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  /* ── Stat card definitions ── */
  const statCards = [
    { icon: Package,     label: 'Total Tools',     value: stats.totalTools,       sublabel: `${stats.activeTools} active`,    hex: '#2563EB' },
    { icon: Users,       label: 'Total Members',   value: stats.totalClients,     sublabel: `${stats.activeClients} active`,  hex: '#16A34A' },
    { icon: TrendingUp,  label: 'Assignments',     value: stats.totalAssignments, sublabel: 'Active',                         hex: '#7C3AED' },
    { icon: Shield,      label: 'Device Bindings', value: stats.deviceBindings,   sublabel: 'Secured',                        hex: '#06B6D4' },
  ];

  /* ── Quick actions ── */
  const quickActions = [
    {
      icon: PackagePlus, title: 'Create Tool',
      description: 'Add a new tool to the platform',
      action: () => navigate('/admin/tools/wizard'),
      gradient: 'from-blue-500 to-cyan-500', variant: 'blue',
    },
    {
      icon: UserPlus, title: 'Add Member',
      description: 'Create a new client account',
      action: () => navigate('/admin/clients/new'),
      gradient: 'from-green-500 to-emerald-500', variant: 'green',
    },
    {
      icon: TrendingUp, title: 'Bulk Assign',
      description: 'Assign tools to multiple clients',
      action: () => navigate('/admin/assign'),
      gradient: 'from-purple-500 to-violet-500', variant: 'purple',
    },
  ];

  /* ── Security alert banner ── */
  const SecurityBanner = () => securityAlertCount > 0 ? (
    <Link to="/admin/security"
          className="flex items-center gap-3 p-3.5 mb-6 rounded-xl border border-red-500/30 bg-red-500/10 hover:bg-red-500/15 transition-all">
      <ShieldAlert size={16} className="text-red-500 flex-shrink-0" />
      <span className="text-red-500 text-sm font-semibold flex-1">
        {securityAlertCount} high/critical alert{securityAlertCount !== 1 ? 's' : ''} need attention
      </span>
      <span className="text-xs text-red-500/60">Review →</span>
    </Link>
  ) : null;

  /* ── Loading state ── */
  if (loading) {
    return (
      <AdminLayoutEnhanced>
        <SecurityBanner />
        <div className="max-w-7xl mx-auto space-y-5">
          <div className="h-8 w-48 bg-genz-bg rounded-xl animate-pulse mb-2" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[0,1,2,3].map(i => <SkeletonCard key={i} />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="rounded-2xl border border-genz-border bg-white p-5 h-48 animate-pulse" />
            <div className="rounded-2xl border border-genz-border bg-white p-5 h-48 animate-pulse" />
          </div>
        </div>
      </AdminLayoutEnhanced>
    );
  }

  /* ── Error state ── */
  if (dashboardError) {
    return (
      <AdminLayoutEnhanced>
        <div className="max-w-xl mx-auto mt-16 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
            <AlertCircle size={28} className="text-red-500" />
          </div>
          <h2 className="text-xl font-bold text-genz-navy mb-2">Dashboard unavailable</h2>
          <p className="text-genz-muted text-sm mb-6">{dashboardError}</p>
          <button
            onClick={loadDashboard}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-genz-deep-navy"
            style={{ background: 'linear-gradient(135deg, #06B6D4, #0891B2)' }}
          >
            <RefreshCw size={15} />
            Try Again
          </button>
        </div>
      </AdminLayoutEnhanced>
    );
  }

  /* ── Main render ── */
  return (
    <AdminLayoutEnhanced>
      <div className="max-w-7xl mx-auto space-y-5">

        <SecurityBanner />

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-genz-navy flex items-center gap-2.5">
              <Sparkles className="text-genz-teal" size={22} />
              Welcome back
            </h1>
            <p className="text-genz-muted text-[13px] mt-0.5 flex items-center gap-1.5">
              <Calendar size={13} />
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>
          <button
            onClick={loadDashboard}
            className="p-2.5 rounded-xl border border-genz-border text-genz-muted hover:text-genz-navy hover:border-genz-blue/40 transition-all"
            title="Refresh dashboard"
          >
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Stat Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {statCards.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <div key={i} className="ds-card ds-stat relative overflow-hidden p-4 pt-[18px]">
                <span className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${stat.hex}, ${stat.hex}66)` }} />
                <div className="flex items-center justify-between mb-3">
                  <span className="w-10 h-10 rounded-xl flex items-center justify-center"
                        style={{ background: `${stat.hex}14`, color: stat.hex, border: `1px solid ${stat.hex}26` }}>
                    <Icon size={18} />
                  </span>
                  <span className="ds-badge ds-badge-neutral">{stat.sublabel}</span>
                </div>
                <div className="font-heading text-[28px] font-extrabold text-genz-navy tabular-nums leading-none">{stat.value}</div>
                <div className="text-[12px] font-medium text-genz-muted mt-1.5">{stat.label}</div>
              </div>
            );
          })}
        </div>

        {/* Quick Actions */}
        <div>
          <h2 className="font-heading text-[16px] font-bold text-genz-navy mb-3">Quick Actions</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {quickActions.map((action, i) => {
              const Icon = action.icon;
              return (
                <button key={i} onClick={action.action}
                        className="ds-card ds-stat group p-4 text-left flex items-center gap-3.5">
                  <div className={`w-10 h-10 shrink-0 bg-gradient-to-br ${action.gradient} rounded-xl flex items-center justify-center shadow-md`}>
                    <Icon size={18} className="text-white" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-bold text-genz-navy group-hover:text-genz-blue transition-colors">{action.title}</h3>
                    <p className="text-[12px] text-genz-muted truncate">{action.description}</p>
                  </div>
                  <ArrowRight size={15} className="ml-auto shrink-0 text-genz-blue group-hover:translate-x-1 transition-transform" />
                </button>
              );
            })}
          </div>
        </div>

        {/* Recent Members + Recent Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

          {/* Recent Members table */}
          <div className="lg:col-span-3 ds-card overflow-hidden">
            <div className="ds-panel-head flex items-center justify-between px-5 py-3.5">
              <h2 className="font-heading text-[16px] font-bold text-genz-navy flex items-center gap-2">
                <Users size={16} className="text-genz-blue" /> Recent Members
              </h2>
              <button onClick={() => navigate('/admin/clients')}
                      className="text-[13px] text-genz-blue hover:underline font-semibold inline-flex items-center gap-1">
                View all <ArrowRight size={13} />
              </button>
            </div>

            {recentClients.length === 0 ? (
              <div className="py-14 text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-genz-bg flex items-center justify-center">
                  <Users size={22} className="text-genz-muted" />
                </div>
                <p className="text-genz-navy font-semibold text-sm">No members yet</p>
                <p className="text-genz-muted text-xs mt-1">Add your first member to get started.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="ds-table">
                  <thead><tr><th>Member</th><th>Email</th><th>Status</th></tr></thead>
                  <tbody>
                    {recentClients.map((client, idx) => {
                      const name = client?.fullName || 'Unknown';
                      const email = client?.email || '—';
                      const status = client?.status || 'unknown';
                      const initial = name.charAt(0).toUpperCase() || '?';
                      const id = client?._id || client?.id || idx;
                      return (
                        <tr key={String(id)}
                            className="cursor-pointer"
                            onClick={() => id && id !== idx && navigate(`/admin/clients/${id}/edit`)}>
                          <td>
                            <div className="flex items-center gap-3">
                              <span className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 font-bold text-[13px] text-white"
                                    style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)' }}>{initial}</span>
                              <span className="font-semibold text-genz-navy">{name}</span>
                            </div>
                          </td>
                          <td className="text-genz-muted">{email}</td>
                          <td>
                            <span className={`ds-badge ${status === 'active' ? 'ds-badge-success' : 'ds-badge-danger'}`}>
                              <span className="dot" /> {status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent Activity feed */}
          <div className="lg:col-span-2 ds-card overflow-hidden">
            <div className="ds-panel-head flex items-center justify-between px-5 py-3.5">
              <h2 className="font-heading text-[16px] font-bold text-genz-navy flex items-center gap-2">
                <ActivityIcon size={16} className="text-genz-blue" /> Recent Activity
              </h2>
              <button onClick={() => navigate('/admin/activity')}
                      className="text-[13px] text-genz-blue hover:underline font-semibold">View all</button>
            </div>

            {recentActivity.length === 0 ? (
              <div className="py-14 text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-genz-bg flex items-center justify-center">
                  <ActivityIcon size={22} className="text-genz-muted" />
                </div>
                <p className="text-genz-navy font-semibold text-sm">No recent activity</p>
              </div>
            ) : (
              <div className="ds-scroll max-h-[360px] overflow-y-auto p-3">
                {recentActivity.map((activity, idx) => {
                  const action = String(activity?.action || '');
                  const actorRole = String(activity?.actorRole || '');
                  const createdAt = activity?.createdAt || null;
                  const actId = activity?._id || activity?.id || idx;
                  const label = action.replace(/_/g, ' ').toLowerCase() || 'activity';
                  return (
                    <div key={String(actId)} className="flex items-start gap-3 px-2.5 py-2.5 rounded-xl hover:bg-genz-bg transition-colors">
                      <span className="mt-0.5 w-7 h-7 rounded-lg bg-genz-bg flex items-center justify-center flex-shrink-0">{getActionIcon(action)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] text-genz-navy leading-snug capitalize">
                          {actorRole && <span className="font-semibold mr-1">{actorRole}</span>}
                          <span className="text-genz-muted">{label}</span>
                        </p>
                        <p className="text-[12px] text-genz-muted mt-0.5">{formatDate(createdAt)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminDashboardEnhanced;
