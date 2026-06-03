import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import { Package, Users, TrendingUp, Activity as ActivityIcon, Link2, FileText, Mail, ArrowRight } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const AdminDashboard = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const [stats, setStats] = useState({
    totalTools: 0,
    totalClients: 0,
    activeClients: 0,
    totalAssignments: 0,
    newContacts: 0,
    publishedPosts: 0
  });
  const [recentActivity, setRecentActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    loadDashboard();
  }, []);
  
  const loadDashboard = async () => {
    try {
      setLoading(true);
      
      const [toolsRes, clientsRes, activityRes, contactsRes, blogRes] = await Promise.all([
        api.get('/admin/tools'),
        api.get('/admin/clients'),
        api.get('/admin/activity?limit=8'),
        api.get('/admin/contacts/stats').catch(() => ({ data: { stats: {} } })),
        api.get('/admin/blog/stats').catch(() => ({ data: { stats: {} } }))
      ]);
      
      const tools = toolsRes.data.tools || [];
      const clients = clientsRes.data.clients || [];
      const activeClients = clients.filter(c => c.status === 'active').length;
      const totalAssignments = clients.reduce((sum, c) => sum + (c.assignmentCount || 0), 0);
      
      setStats({
        totalTools: tools.length,
        totalClients: clients.length,
        activeClients,
        totalAssignments,
        newContacts: contactsRes.data.stats?.new || 0,
        publishedPosts: blogRes.data.stats?.published || 0
      });
      
      setRecentActivity(activityRes.data.activities || []);
    } catch (error) {
      console.error('Load dashboard error:', error);
      showError('Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };
  
  const statCards = [
    { icon: Package, label: 'Total Tools', value: stats.totalTools, color: 'bg-blue-500', path: '/admin/tools' },
    { icon: Users, label: 'Total Clients', value: stats.totalClients, color: 'bg-green-500', path: '/admin/clients' },
    { icon: TrendingUp, label: 'Active Clients', value: stats.activeClients, color: 'bg-purple-500', path: '/admin/clients' },
    { icon: Link2, label: 'Assignments', value: stats.totalAssignments, color: 'bg-genz-teal/10', path: '/admin/assign' },
    { icon: Mail, label: 'New Contacts', value: stats.newContacts, color: 'bg-pink-500', path: '/admin/contacts' },
    { icon: FileText, label: 'Blog Posts', value: stats.publishedPosts, color: 'bg-cyan-500', path: '/admin/blog' }
  ];
  
  const quickActions = [
    { icon: Package, label: 'Create Tool', desc: 'Add a new tool', path: '/admin/tools/new', color: 'text-blue-400' },
    { icon: Users, label: 'Add Client', desc: 'Create account', path: '/admin/clients/new', color: 'text-green-400' },
    { icon: Link2, label: 'Bulk Assign', desc: 'Assign tools', path: '/admin/assign', color: 'text-genz-teal' },
    { icon: FileText, label: 'New Post', desc: 'Write blog post', path: '/admin/blog/new', color: 'text-cyan-400' }
  ];
  
  const formatDate = (date) => {
    const d = new Date(date);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleDateString();
  };
  
  const getActionLabel = (activity) => {
    // Get email from populated actorId or use role as fallback
    const email = activity.actorId?.email || null;
    const role = activity.actorRole;
    
    // Get base action
    const action = activity.action;
    
    // Create descriptive labels with email
    if (action === 'ADMIN_LOGIN') {
      return email ? `${email} logged in` : 'Admin logged in';
    }
    if (action === 'ADMIN_LOGIN_FAILED') {
      // Check meta for email if actorId not available
      const failedEmail = email || activity.meta?.email;
      return failedEmail ? `${failedEmail} login failed` : 'Admin login failed';
    }
    if (action === 'CLIENT_LOGIN') {
      return email ? `${email} logged in` : 'Client logged in';
    }
    if (action === 'CLIENT_LOGIN_FAILED') {
      const failedEmail = email || activity.meta?.email;
      return failedEmail ? `${failedEmail} login failed` : 'Client login failed';
    }
    if (action === 'TOOL_CREATED') {
      const toolName = activity.meta?.toolName || 'Tool';
      return email ? `${email} created ${toolName}` : `${toolName} created`;
    }
    if (action === 'TOOL_UPDATED') {
      const toolName = activity.meta?.toolName || 'Tool';
      return email ? `${email} updated ${toolName}` : `${toolName} updated`;
    }
    if (action === 'TOOL_DELETED') {
      const toolName = activity.meta?.toolName || 'Tool';
      return email ? `${email} deleted ${toolName}` : `${toolName} deleted`;
    }
    if (action === 'CLIENT_CREATED') {
      const clientName = activity.meta?.clientName || 'Client';
      return email ? `${email} created ${clientName}` : `${clientName} created`;
    }
    if (action === 'CLIENT_UPDATED') {
      const clientName = activity.meta?.clientName || 'Client';
      return email ? `${email} updated ${clientName}` : `${clientName} updated`;
    }
    if (action === 'TOOL_ASSIGNED') {
      return email ? `${email} assigned tool` : 'Tool assigned';
    }
    if (action === 'BULK_ASSIGNMENT') {
      return email ? `${email} performed bulk assignment` : 'Bulk assignment';
    }
    if (action === 'DEVICE_RESET') {
      return email ? `${email} reset device` : 'Device reset';
    }
    if (action === 'BLOG_CREATED') {
      return email ? `${email} created blog post` : 'Blog post created';
    }
    if (action === 'CONTACT_UPDATED') {
      return email ? `${email} updated contact` : 'Contact updated';
    }
    
    // Default fallback
    return email ? `${email} - ${action.replace(/_/g, ' ').toLowerCase()}` : action.replace(/_/g, ' ').toLowerCase();
  };
  
  if (loading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-genz-teal border-t-transparent"></div>
        </div>
      </AdminLayout>
    );
  }
  
  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">Dashboard</h1>
          <p className="text-genz-muted text-sm">Welcome back! Here's your CRM overview.</p>
        </div>
        
        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          {statCards.map((stat, index) => {
            const Icon = stat.icon;
            return (
              <button
                key={index}
                onClick={() => navigate(stat.path)}
                className="bg-white/[0.04] border border-white/10 rounded-xl p-4 hover:border-genz-teal transition-all duration-300 text-left group"
              >
                <div className={`w-10 h-10 ${stat.color} rounded-lg flex items-center justify-center mb-3`}>
                  <Icon size={20} className="text-white" />
                </div>
                <div className="text-2xl font-bold text-white mb-0.5 group-hover:text-genz-teal transition-colors">{stat.value}</div>
                <div className="text-xs text-genz-muted">{stat.label}</div>
              </button>
            );
          })}
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Quick Actions */}
          <div className="lg:col-span-1">
            <div className="bg-white/[0.04] border border-white/10 rounded-xl p-5">
              <h2 className="text-lg font-semibold text-white mb-4">Quick Actions</h2>
              <div className="space-y-2">
                {quickActions.map((action, index) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={index}
                      onClick={() => navigate(action.path)}
                      className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-white/5 transition-colors group text-left"
                    >
                      <div className={`w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center ${action.color}`}>
                        <Icon size={18} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-white group-hover:text-genz-teal transition-colors">{action.label}</div>
                        <div className="text-xs text-genz-muted">{action.desc}</div>
                      </div>
                      <ArrowRight size={16} className="text-genz-muted group-hover:text-genz-teal transition-colors" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          
          {/* Recent Activity */}
          <div className="lg:col-span-2">
            <div className="bg-white/[0.04] border border-white/10 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Recent Activity</h2>
                <button 
                  onClick={() => navigate('/admin/activity')}
                  className="text-xs text-genz-teal hover:underline"
                >
                  View All
                </button>
              </div>
              
              {recentActivity.length === 0 ? (
                <div className="text-center py-8 text-genz-muted">
                  <ActivityIcon size={40} className="mx-auto mb-3 opacity-50" />
                  <p className="text-sm">No recent activity</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {recentActivity.map((activity) => (
                    <div
                      key={activity._id}
                      className="flex items-center justify-between p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          activity.action.includes('LOGIN') ? 'bg-blue-400' :
                          activity.action.includes('CREATE') ? 'bg-green-400' :
                          activity.action.includes('DELETE') ? 'bg-red-400' :
                          activity.action.includes('FAILED') ? 'bg-red-400' :
                          'bg-yellow-400'
                        }`} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-white truncate">
                            {getActionLabel(activity)}
                          </p>
                          <p className="text-xs text-genz-muted">
                            {activity.actorRole}
                          </p>
                        </div>
                      </div>
                      <span className="text-xs text-genz-muted flex-shrink-0 ml-4">
                        {formatDate(activity.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
};

export default AdminDashboard;
