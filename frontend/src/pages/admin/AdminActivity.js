import { useState, useEffect } from 'react';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import { Activity, Search, Filter, RefreshCw, ChevronLeft, ChevronRight, Calendar, Download, History } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const AdminActivity = () => {
  const { showError } = useToast();
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    role: '',
    action: '',
    search: '',
    startDate: '',
    endDate: ''
  });
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0
  });

  useEffect(() => {
    loadActivities();
  }, [pagination.page, filters.role, filters.action, filters.startDate, filters.endDate]);

  const loadActivities = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: pagination.page,
        limit: pagination.limit
      });
      
      if (filters.role) params.append('role', filters.role);
      if (filters.action) params.append('action', filters.action);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      
      const res = await api.get(`/admin/activity?${params}`);
      setActivities(res.data.activities || []);
      setPagination(prev => ({ ...prev, total: res.data.total || 0 }));
    } catch (error) {
      showError('Failed to load activities');
    } finally {
      setLoading(false);
    }
  };

  const exportToCSV = () => {
    const headers = ['Time', 'Email', 'Role', 'Action', 'Details'];
    const rows = activities.map(a => [
      formatDate(a.createdAt),
      a.actorId?.email || a.meta?.email || 'N/A',
      a.actorRole,
      a.action,
      getActivityDescription(a)
    ]);
    
    const csvContent = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `activity-log-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const clearFilters = () => {
    setFilters({ role: '', action: '', search: '', startDate: '', endDate: '' });
    setPagination(prev => ({ ...prev, page: 1 }));
  };

  const formatDate = (date) => {
    return new Date(date).toLocaleString();
  };
  
  const getActivityDescription = (activity) => {
    const email = activity.actorId?.email || activity.meta?.email || null;
    const action = activity.action;
    
    // Build description with email if available
    if (action.includes('LOGIN')) {
      if (action.includes('FAILED')) {
        return email ? `Login failed for ${email}` : 'Login failed';
      }
      return email ? `${email} logged in` : 'Login successful';
    }
    
    if (action.includes('TOOL_CREATED')) {
      const toolName = activity.meta?.toolName || 'tool';
      return email ? `${email} created ${toolName}` : `Created ${toolName}`;
    }
    
    if (action.includes('TOOL_UPDATED')) {
      const toolName = activity.meta?.toolName || 'tool';
      return email ? `${email} updated ${toolName}` : `Updated ${toolName}`;
    }
    
    if (action.includes('TOOL_DELETED')) {
      const toolName = activity.meta?.toolName || 'tool';
      return email ? `${email} deleted ${toolName}` : `Deleted ${toolName}`;
    }
    
    if (action.includes('CLIENT_CREATED')) {
      const clientEmail = activity.meta?.clientEmail || 'client';
      return email ? `${email} created client ${clientEmail}` : `Created client ${clientEmail}`;
    }
    
    if (action.includes('CLIENT_UPDATED')) {
      const clientEmail = activity.meta?.clientEmail || 'client';
      return email ? `${email} updated client ${clientEmail}` : `Updated client ${clientEmail}`;
    }
    
    // Default with email if available
    const actionText = action.replace(/_/g, ' ').toLowerCase();
    return email ? `${email} - ${actionText}` : actionText;
  };

  const getActionColor = (action) => {
    if (action.includes('LOGIN')) return 'text-blue-500 bg-blue-500/10';
    if (action.includes('CREATE') || action.includes('ASSIGN')) return 'text-green-500 bg-green-500/10';
    if (action.includes('DELETE') || action.includes('BLOCKED')) return 'text-red-500 bg-red-500/10';
    if (action.includes('UPDATE') || action.includes('RESET')) return 'text-yellow-500 bg-yellow-500/10';
    return 'text-genz-muted bg-genz-bg';
  };

  const totalPages = Math.ceil(pagination.total / pagination.limit);

  const actionTypes = [
    'ADMIN_LOGIN', 'CLIENT_LOGIN', 'LOGIN_BLOCKED_DISABLED', 'LOGIN_BLOCKED_DEVICE',
    'TOOL_CREATED', 'TOOL_UPDATED', 'TOOL_DELETED',
    'CLIENT_CREATED', 'CLIENT_UPDATED', 'CLIENT_DELETED',
    'TOOL_ASSIGNED', 'TOOL_UNASSIGNED', 'BULK_ASSIGNMENT',
    'DEVICE_RESET', 'TOOL_COOKIES_ACCESSED'
  ];

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-genz-navy mb-2 flex items-center gap-3">
              <History className="text-genz-teal" size={32} />
              Activity Log
            </h1>
            <p className="text-genz-muted">Monitor all system activities and events</p>
          </div>
          <button
            onClick={loadActivities}
            className={`flex items-center gap-2 px-4 py-2.5 ${ADMIN_CARD_VARIANTS.default} rounded-xl text-genz-navy hover:border-genz-teal/50 transition-colors`}
            data-testid="refresh-activity-btn"
          >
            <RefreshCw size={18} />
            Refresh
          </button>
        </div>

        {/* Filters */}
        <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-6 mb-6`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-genz-navy">
              <Filter size={18} />
              <span className="font-medium">Filters</span>
            </div>
            <div className="flex items-center gap-2">
              {(filters.role || filters.action || filters.startDate || filters.endDate) && (
                <button
                  onClick={clearFilters}
                  className="text-xs text-genz-teal hover:underline"
                >
                  Clear all
                </button>
              )}
              <button
                onClick={exportToCSV}
                disabled={activities.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-genz-bg border border-genz-border rounded-lg text-sm text-genz-navy hover:border-genz-teal/50 transition-colors disabled:opacity-50"
              >
                <Download size={14} />
                Export CSV
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label className="text-sm text-genz-muted mb-1.5 block">Role</label>
              <select
                value={filters.role}
                onChange={(e) => {
                  setFilters(prev => ({ ...prev, role: e.target.value }));
                  setPagination(prev => ({ ...prev, page: 1 }));
                }}
                className="w-full px-3 py-2.5 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all text-sm appearance-none cursor-pointer"
                style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.75rem center', backgroundSize: '0.75rem' }}
                data-testid="filter-role"
              >
                <option value="" className="bg-[#1a1a22] text-genz-navy">All Roles</option>
                <option value="ADMIN" className="bg-[#1a1a22] text-genz-navy">Admin</option>
                <option value="CLIENT" className="bg-[#1a1a22] text-genz-navy">Client</option>
                <option value="SYSTEM" className="bg-[#1a1a22] text-genz-navy">System</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-genz-muted mb-1.5 block">Action</label>
              <select
                value={filters.action}
                onChange={(e) => {
                  setFilters(prev => ({ ...prev, action: e.target.value }));
                  setPagination(prev => ({ ...prev, page: 1 }));
                }}
                className="w-full px-3 py-2.5 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all text-sm appearance-none cursor-pointer"
                style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.75rem center', backgroundSize: '0.75rem' }}
                data-testid="filter-action"
              >
                <option value="" className="bg-[#1a1a22] text-genz-navy">All Actions</option>
                {actionTypes.map(action => (
                  <option key={action} value={action} className="bg-[#1a1a22] text-genz-navy">{action.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-genz-muted mb-1.5 block flex items-center gap-1">
                <Calendar size={12} /> From Date
              </label>
              <input
                type="date"
                value={filters.startDate}
                onChange={(e) => {
                  setFilters(prev => ({ ...prev, startDate: e.target.value }));
                  setPagination(prev => ({ ...prev, page: 1 }));
                }}
                className="w-full px-3 py-2.5 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all text-sm cursor-pointer"
                data-testid="filter-start-date"
              />
            </div>
            <div>
              <label className="text-sm text-genz-muted mb-1.5 block flex items-center gap-1">
                <Calendar size={12} /> To Date
              </label>
              <input
                type="date"
                value={filters.endDate}
                min={filters.startDate}
                onChange={(e) => {
                  setFilters(prev => ({ ...prev, endDate: e.target.value }));
                  setPagination(prev => ({ ...prev, page: 1 }));
                }}
                className="w-full px-3 py-2.5 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all text-sm cursor-pointer"
                data-testid="filter-end-date"
              />
            </div>
            <div>
              <label className="text-sm text-genz-muted mb-1.5 block">Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={16} />
                <input
                  type="text"
                  placeholder="Search metadata..."
                  value={filters.search}
                  onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
                  className="w-full pl-10 pr-3 py-2.5 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all text-sm"
                  data-testid="filter-search"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Activity List */}
        {loading ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl overflow-hidden`} aria-busy="true" aria-label="Loading activities">
            <div className="hidden sm:grid grid-cols-4 gap-4 px-6 py-4 border-b border-genz-border">
              {['Time', 'Role', 'Action', 'Details'].map((h) => (
                <div key={h} className="text-sm font-medium text-genz-muted">{h}</div>
              ))}
            </div>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-6 py-4 border-b border-genz-border animate-pulse">
                <div className="h-3 w-24 rounded bg-white" />
                <div className="h-5 w-16 rounded-full bg-white" />
                <div className="h-5 w-24 rounded-full bg-genz-bg" />
                <div className="h-3 w-3/4 rounded bg-white" />
              </div>
            ))}
          </div>
        ) : activities.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-12 text-center`}>
            <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-purple-500/20 to-blue-500/20 rounded-2xl flex items-center justify-center">
              <Activity size={40} className="text-genz-muted" />
            </div>
            <h3 className="text-lg font-medium text-genz-navy mb-2">No activity found</h3>
            <p className="text-genz-muted">Try adjusting your filters</p>
          </div>
        ) : (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl overflow-hidden`}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-genz-border">
                    <th className="text-left px-6 py-4 text-sm font-medium text-genz-muted">Time</th>
                    <th className="text-left px-6 py-4 text-sm font-medium text-genz-muted">Role</th>
                    <th className="text-left px-6 py-4 text-sm font-medium text-genz-muted">Action</th>
                    <th className="text-left px-6 py-4 text-sm font-medium text-genz-muted">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {activities
                    .filter(a => !filters.search || JSON.stringify(a.meta || {}).toLowerCase().includes(filters.search.toLowerCase()))
                    .map((activity) => (
                    <tr key={activity._id} className="border-b border-genz-border hover:bg-genz-bg transition-colors">
                      <td className="px-6 py-4 text-sm text-genz-muted whitespace-nowrap">
                        {formatDate(activity.createdAt)}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2.5 py-1 text-xs rounded-full ${
                          activity.actorRole === 'ADMIN' ? 'bg-purple-500/10 text-purple-500' :
                          activity.actorRole === 'CLIENT' ? 'bg-blue-500/10 text-blue-500' :
                          'bg-gray-500/10 text-gray-500'
                        }`}>
                          {activity.actorRole}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2.5 py-1 text-xs rounded-full ${getActionColor(activity.action)}`}>
                          {activity.action.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-genz-navy">
                        {getActivityDescription(activity)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-6 py-4 border-t border-genz-border">
                <span className="text-sm text-genz-muted">
                  Page {pagination.page} of {totalPages} ({pagination.total} total)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                    disabled={pagination.page === 1}
                    className="p-2 text-genz-muted hover:text-genz-navy disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <button
                    onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                    disabled={pagination.page >= totalPages}
                    className="p-2 text-genz-muted hover:text-genz-navy disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight size={20} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminActivity;
