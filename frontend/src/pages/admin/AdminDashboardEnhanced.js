import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
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
    <div className="rounded-2xl p-6 border border-genz-border bg-white animate-pulse">
      <div className="flex items-center justify-between mb-5">
        <div className="w-12 h-12 rounded-xl bg-genz-bg" />
      </div>
      <div className="h-8 w-16 bg-genz-bg rounded mb-2" />
      <div className="h-4 w-24 bg-genz-bg rounded mb-1" />
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
    {
      icon: Package, label: 'Total Tools', value: stats.totalTools,
      sublabel: `${stats.activeTools} active`,
      variant: 'blue', textColor: 'text-blue-500', glow: 'bg-blue-500/20',
    },
    {
      icon: Users, label: 'Total Members', value: stats.totalClients,
      sublabel: `${stats.activeClients} active`,
      variant: 'green', textColor: 'text-green-500', glow: 'bg-green-500/20',
    },
    {
      icon: TrendingUp, label: 'Assignments', value: stats.totalAssignments,
      sublabel: 'Active',
      variant: 'purple', textColor: 'text-purple-500', glow: 'bg-purple-500/20',
    },
    {
      icon: Shield, label: 'Device Bindings', value: stats.deviceBindings,
      sublabel: 'Secured devices',
      variant: 'teal', textColor: 'text-genz-teal', glow: 'bg-genz-teal/20',
    },
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
        <div className="max-w-7xl mx-auto space-y-8">
          <div className="h-10 w-48 bg-genz-bg rounded-xl animate-pulse mb-2" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[0,1,2,3].map(i => <SkeletonCard key={i} />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-genz-border bg-white p-6 h-56 animate-pulse" />
            <div className="rounded-2xl border border-genz-border bg-white p-6 h-56 animate-pulse" />
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
      <div className="max-w-7xl mx-auto space-y-8">

        <SecurityBanner />

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-black text-genz-navy flex items-center gap-3">
              <Sparkles className="text-genz-teal" size={26} />
              Welcome back
            </h1>
            <p className="text-genz-muted text-sm mt-1 flex items-center gap-1.5">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {statCards.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <div key={i}
                   className={`group relative overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${ADMIN_CARD_VARIANTS[stat.variant] || ADMIN_CARD_VARIANTS.default}`}>
                {/* Hover glow */}
                <div className={`absolute top-0 right-0 w-28 h-28 ${stat.glow} opacity-0 group-hover:opacity-40 rounded-full blur-3xl transition-opacity duration-500 pointer-events-none`} />
                <div className="relative p-6">
                  <div className={`w-12 h-12 rounded-xl ${stat.glow} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                    <Icon size={24} className={stat.textColor} />
                  </div>
                  <div className="text-3xl font-black text-genz-navy mb-1 tabular-nums">{stat.value}</div>
                  <div className="text-sm text-genz-muted font-medium mb-1">{stat.label}</div>
                  <div className={`text-xs ${stat.textColor} flex items-center gap-1`}>
                    <TrendingUp size={11} /> {stat.sublabel}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Quick Actions */}
        <div>
          <h2 className="text-lg font-bold text-genz-navy mb-4">Quick Actions</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {quickActions.map((action, i) => {
              const Icon = action.icon;
              return (
                <button key={i} onClick={action.action}
                        className={`group relative overflow-hidden rounded-2xl p-5 text-left transition-all duration-300 hover:-translate-y-1 hover:shadow-xl ${ADMIN_CARD_VARIANTS[action.variant] || ADMIN_CARD_VARIANTS.default}`}>
                  <div className={`absolute top-0 right-0 w-36 h-36 bg-gradient-to-br ${action.gradient} opacity-0 group-hover:opacity-15 rounded-full blur-3xl transition-opacity duration-500 pointer-events-none`} />
                  <div className="relative">
                    <div className={`w-12 h-12 bg-gradient-to-br ${action.gradient} rounded-xl flex items-center justify-center mb-4 shadow-lg group-hover:scale-110 transition-transform`}>
                      <Icon size={24} className="text-genz-navy" />
                    </div>
                    <h3 className="text-base font-bold text-genz-navy mb-1 group-hover:text-genz-teal transition-colors">{action.title}</h3>
                    <p className="text-xs text-genz-muted mb-3">{action.description}</p>
                    <span className="inline-flex items-center gap-1.5 text-xs text-genz-teal font-semibold">
                      Get Started <ArrowRight size={12} className="group-hover:translate-x-1 transition-transform" />
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Recent Clients + Recent Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Recent Clients */}
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-6`}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-genz-navy flex items-center gap-2">
                <Users size={16} className="text-genz-teal" /> Recent Members
              </h2>
              <button onClick={() => navigate('/admin/clients')}
                      className="text-xs text-genz-teal hover:underline font-medium">
                View All
              </button>
            </div>

            {recentClients.length === 0 ? (
              <div className="py-10 text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-green-500/10 flex items-center justify-center">
                  <Users size={24} className="text-genz-muted" />
                </div>
                <p className="text-genz-muted text-sm">No members yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {recentClients.map((client, idx) => {
                  const name   = client?.fullName || 'Unknown';
                  const email  = client?.email    || '';
                  const status = client?.status   || 'unknown';
                  const initial = name.charAt(0).toUpperCase() || '?';
                  const id = client?._id || client?.id || idx;
                  return (
                    <div key={String(id)}
                         className="flex items-center gap-3 p-3 rounded-xl bg-white border border-white/[0.06] hover:bg-white hover:border-genz-teal/20 transition-all cursor-pointer"
                         onClick={() => id && id !== idx && navigate(`/admin/clients/${id}/edit`)}>
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 font-bold text-sm text-genz-deep-navy"
                           style={{ background: 'linear-gradient(135deg, #06B6D4, #0891B2)' }}>
                        {initial}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-genz-navy truncate">{name}</p>
                        <p className="text-xs text-genz-muted truncate">{email}</p>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${
                        status === 'active'
                          ? 'bg-green-500/20 text-green-500'
                          : 'bg-red-500/20 text-red-500'
                      }`}>
                        {status}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Activity */}
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-6`}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-genz-navy flex items-center gap-2">
                <ActivityIcon size={16} className="text-genz-teal" /> Recent Activity
              </h2>
              <button onClick={() => navigate('/admin/activity')}
                      className="text-xs text-genz-teal hover:underline font-medium">
                View All
              </button>
            </div>

            {recentActivity.length === 0 ? (
              <div className="py-10 text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-purple-500/10 flex items-center justify-center">
                  <ActivityIcon size={24} className="text-genz-muted" />
                </div>
                <p className="text-genz-muted text-sm">No recent activity</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1
                              [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:transparent
                              [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-genz-bg">
                {recentActivity.map((activity, idx) => {
                  const action     = String(activity?.action      || '');
                  const actorRole  = String(activity?.actorRole   || '');
                  const createdAt  = activity?.createdAt          || null;
                  const actId      = activity?._id || activity?.id || idx;
                  const label      = action.replace(/_/g, ' ').toLowerCase() || 'activity';
                  return (
                    <div key={String(actId)}
                         className="flex items-start gap-2.5 p-3 rounded-xl bg-white border border-white/[0.06] hover:bg-white transition-colors">
                      <div className="mt-0.5">{getActionIcon(action)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-genz-navy leading-relaxed">
                          {actorRole && <span className="font-semibold text-genz-muted mr-1">{actorRole}</span>}
                          <span className="text-genz-muted">{label}</span>
                        </p>
                        <p className="text-xs text-genz-muted mt-0.5">{formatDate(createdAt)}</p>
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
