import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import { 
  Package, 
  Users, 
  TrendingUp, 
  Activity as ActivityIcon,
  UserPlus,
  PackagePlus,
  Wand2,
  Clock,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Calendar,
  Sparkles,
  ShieldAlert
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const AdminDashboardEnhanced = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const [stats, setStats] = useState({
    totalTools: 0,
    activeTools: 0,
    totalClients: 0,
    activeClients: 0,
    disabledClients: 0,
    totalAssignments: 0,
    deviceBindings: 0
  });
  const [recentActivity, setRecentActivity] = useState([]);
  const [recentClients, setRecentClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [securityAlertCount, setSecurityAlertCount] = useState(0);
  
  useEffect(() => {
    loadDashboard();
    api.get('/admin/security-alerts?status=open&limit=1')
      .then(r => { if (r.data?.stats?.highCount > 0) setSecurityAlertCount(r.data.stats.highCount); })
      .catch(() => {});
  }, []);
  
  const loadDashboard = async () => {
    try {
      setLoading(true);
      
      const [toolsRes, clientsRes, clientStatsRes, activityRes] = await Promise.all([
        api.get('/admin/tools/stats'),
        api.get('/admin/clients?limit=5'),
        api.get('/admin/clients/stats'),
        api.get('/admin/activity?limit=10')
      ]);
      
      const toolStats = toolsRes.data.stats || {};
      const clientStats = clientStatsRes.data.stats || {};
      const clients = clientsRes.data.clients || [];
      
      // Calculate total assignments
      const totalAssignments = clients.reduce((sum, c) => sum + (c?.assignmentCount || 0), 0);
      
      setStats({
        totalTools: toolStats.totalTools || 0,
        activeTools: toolStats.activeTools || 0,
        totalClients: clientStats.totalClients || 0,
        activeClients: clientStats.activeClients || 0,
        disabledClients: clientStats.disabledClients || 0,
        totalAssignments,
        deviceBindings: clientStats.clientsWithDeviceBinding || 0
      });
      
      setRecentClients(clientStats.recentClients || []);
      setRecentActivity(activityRes.data.activities || []);
    } catch (error) {
      console.error('Load dashboard error:', error);
      showError('Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };
  
  const statCards = [
    { 
      icon: Package, 
      label: 'Total Tools', 
      value: stats.totalTools,
      sublabel: `${stats.activeTools} active`,
      variant: 'blue',
      textColor: 'text-blue-400',
      bgColor: 'bg-blue-500/20'
    },
    { 
      icon: Users, 
      label: 'Total Clients', 
      value: stats.totalClients,
      sublabel: `${stats.activeClients} active`,
      variant: 'green',
      textColor: 'text-green-400',
      bgColor: 'bg-green-500/20'
    },
    { 
      icon: TrendingUp, 
      label: 'Assignments', 
      value: stats.totalAssignments,
      sublabel: 'Active assignments',
      variant: 'purple',
      textColor: 'text-purple-400',
      bgColor: 'bg-purple-500/20'
    },
    { 
      icon: ActivityIcon, 
      label: 'Device Bindings', 
      value: stats.deviceBindings,
      sublabel: 'Secured clients',
      variant: 'orange',
      textColor: 'text-genz-teal',
      bgColor: 'bg-genz-teal/10/20'
    }
  ];
  
  const quickActions = [
    {
      icon: PackagePlus,
      title: 'Create Tool',
      description: 'Add a new tool to the platform',
      action: () => navigate('/admin/tools/wizard'),
      variant: 'blue',
      gradient: 'from-blue-500 to-blue-600'
    },
    {
      icon: UserPlus,
      title: 'Add Client',
      description: 'Create a new client account',
      action: () => navigate('/admin/clients/new'),
      variant: 'green',
      gradient: 'from-green-500 to-green-600'
    },
    {
      icon: TrendingUp,
      title: 'Bulk Assign',
      description: 'Assign tools to multiple clients',
      action: () => navigate('/admin/assign'),
      variant: 'purple',
      gradient: 'from-purple-500 to-purple-600'
    }
  ];
  
  const formatDate = (date) => {
    const d = new Date(date);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000); // seconds
    
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleDateString();
  };
  
  const getActionIcon = (action) => {
    if (action.includes('LOGIN')) return <CheckCircle2 size={16} className="text-green-400" />;
    if (action.includes('CREATED')) return <UserPlus size={16} className="text-blue-400" />;
    if (action.includes('DELETED')) return <AlertCircle size={16} className="text-red-400" />;
    if (action.includes('UPDATED')) return <Clock size={16} className="text-yellow-400" />;
    return <ActivityIcon size={16} className="text-gray-400" />;
  };
  
  if (loading) {
    return (
      <AdminLayoutEnhanced>
      {/* Security alerts banner — shown when high/critical alerts are open */}
      {securityAlertCount > 0 && (
        <Link to="/admin/security"
              className="flex items-center gap-3 p-3 mb-5 rounded-xl border border-red-500/30 bg-red-500/10 hover:bg-red-500/15 transition-all">
          <ShieldAlert size={16} className="text-red-400 flex-shrink-0" />
          <span className="text-red-400 text-sm font-semibold">
            {securityAlertCount} high/critical security alert{securityAlertCount !== 1 ? 's' : ''} need attention
          </span>
          <span className="ml-auto text-xs text-red-400/60">Review →</span>
        </Link>
      )}

        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-genz-teal border-t-transparent mx-auto mb-4"></div>
            <p className="text-white/60">Loading dashboard...</p>
          </div>
        </div>
      </AdminLayoutEnhanced>
    );
  }
  
  return (
    <AdminLayoutEnhanced>
      <div className="max-w-7xl mx-auto space-y-8" data-testid="admin-dashboard">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2 flex items-center gap-3">
              <Sparkles className="text-genz-teal" size={32} />
              Dashboard
            </h1>
            <p className="text-white/60 flex items-center gap-2">
              <Calendar size={16} />
              Welcome back! Here&apos;s what&apos;s happening today
            </p>
          </div>
        </div>
        
        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {statCards.map((stat, index) => {
            const Icon = stat.icon;
            return (
              <div
                key={index}
                className={`group relative overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${ADMIN_CARD_VARIANTS[stat.variant]}`}
                data-testid={`stat-card-${index}`}
              >
                {/* Glow effect */}
                <div className={`absolute top-0 right-0 w-32 h-32 ${stat.bgColor} opacity-0 group-hover:opacity-50 rounded-full blur-3xl transition-opacity duration-500`} />
                
                <div className="relative p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className={`w-14 h-14 ${stat.bgColor} rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform`}>
                      <Icon size={28} className={stat.textColor} />
                    </div>
                  </div>
                  <div className="text-4xl font-bold text-white mb-2">{stat.value}</div>
                  <div className="text-sm text-white/60 font-medium mb-1">{stat.label}</div>
                  <div className={`text-xs ${stat.textColor} flex items-center gap-1`}>
                    <TrendingUp size={12} />
                    {stat.sublabel}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        
        {/* Quick Actions */}
        <div>
          <h2 className="text-xl font-bold text-white mb-4">Quick Actions</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {quickActions.map((action, index) => {
              const Icon = action.icon;
              
              return (
                <button
                  key={index}
                  onClick={action.action}
                  className={`group relative overflow-hidden rounded-2xl p-6 text-left transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${ADMIN_CARD_VARIANTS[action.variant]}`}
                  data-testid={`quick-action-${index}`}
                >
                  {/* Glow effect */}
                  <div className={`absolute top-0 right-0 w-40 h-40 bg-gradient-to-br ${action.gradient} opacity-0 group-hover:opacity-20 rounded-full blur-3xl transition-opacity duration-500`} />
                  
                  <div className="relative">
                    <div className={`w-14 h-14 bg-gradient-to-br ${action.gradient} rounded-xl flex items-center justify-center mb-4 shadow-lg group-hover:scale-110 transition-transform`}>
                      <Icon size={28} className="text-white" />
                    </div>
                    <h3 className="text-lg font-semibold text-white mb-2 group-hover:text-genz-teal transition-colors">
                      {action.title}
                    </h3>
                    <p className="text-sm text-white/60 mb-4">
                      {action.description}
                    </p>
                    <div className="flex items-center gap-2 text-genz-teal text-sm font-medium">
                      <span>Get Started</span>
                      <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent Clients */}
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-6`}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Recent Clients</h2>
              <button 
                onClick={() => navigate('/admin/clients')}
                className="text-genz-teal hover:underline text-sm font-medium"
              >
                View All
              </button>
            </div>
            
            {recentClients.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-green-500/20 to-cyan-500/20 rounded-2xl flex items-center justify-center">
                  <Users size={32} className="text-white/40" />
                </div>
                <p className="text-white/60">No clients yet</p>
              </div>
            ) : (
              <div className="space-y-3">
                {recentClients.map((client) => (
                  <div
                    key={client._id}
                    className="flex items-center gap-4 p-4 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 hover:border-genz-teal/30 transition-all cursor-pointer"
                    onClick={() => navigate(`/admin/clients/${client._id}/edit`)}
                  >
                    <div className="w-12 h-12 bg-gradient-to-br from-genz-teal to-genz-dark-teal rounded-xl flex items-center justify-center flex-shrink-0 shadow-lg">
                      <span className="text-white font-bold text-lg">
                        {client.fullName?.charAt(0) || '?'}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-white truncate">{client.fullName}</h3>
                      <p className="text-sm text-white/50 truncate">{client.email}</p>
                    </div>
                    <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                      client.status === 'active' 
                        ? 'bg-green-500/20 text-green-400' 
                        : 'bg-red-500/20 text-red-400'
                    }`}>
                      {client.status}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          {/* Recent Activity */}
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-6`}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Recent Activity</h2>
              <button 
                onClick={() => navigate('/admin/activity')}
                className="text-genz-teal hover:underline text-sm font-medium"
              >
                View All
              </button>
            </div>
            
            {recentActivity.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-purple-500/20 to-blue-500/20 rounded-2xl flex items-center justify-center">
                  <ActivityIcon size={32} className="text-white/40" />
                </div>
                <p className="text-white/60">No recent activity</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {recentActivity.map((activity) => (
                  <div
                    key={activity._id}
                    className="flex items-start gap-3 p-3 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-colors"
                  >
                    <div className="mt-0.5">
                      {getActionIcon(activity.action)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm">
                        <span className="font-semibold">{activity.actorRole}</span>
                        {' '}
                        <span className="text-white/60">
                          {activity.action.replace(/_/g, ' ').toLowerCase()}
                        </span>
                      </p>
                      <p className="text-xs text-white/50 mt-1">
                        {formatDate(activity.createdAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminDashboardEnhanced;
