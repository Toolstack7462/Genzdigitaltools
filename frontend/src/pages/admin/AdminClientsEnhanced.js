import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import { 
  Users, 
  Plus, 
  Search, 
  Edit2, 
  Trash2, 
  ShieldOff,
  LogOut,
  Smartphone,
  TrendingUp,
  Clock,
  UserPlus
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const AdminClientsEnhanced = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [pagination, setPagination] = useState({ page: 1, limit: 12, totalPages: 0 });
  
  useEffect(() => {
    loadClients();
  }, [pagination.page, selectedStatus]);
  
  const loadClients = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: pagination.page,
        limit: pagination.limit
      });
      
      if (searchTerm) params.append('search', searchTerm);
      if (selectedStatus) params.append('status', selectedStatus);
      
      const response = await api.get(`/admin/clients?${params}`);
      setClients(response.data.clients || []);
      setPagination(prev => ({ ...prev, ...response.data.pagination }));
    } catch (error) {
      console.error('Load clients error:', error);
      showError('Failed to load clients');
    } finally {
      setLoading(false);
    }
  };
  
  const handleSearch = () => {
    setPagination(prev => ({ ...prev, page: 1 }));
    loadClients();
  };
  
  const handleDeviceReset = async (clientId, clientName) => {
    if (!window.confirm(`Reset device binding for "${clientName}"? They will need to login again.`)) return;
    
    try {
      await api.post(`/admin/clients/${clientId}/device-reset`);
      showSuccess('Device binding reset successfully');
      loadClients();
    } catch (error) {
      showError(error.response?.data?.error || 'Failed to reset device');
    }
  };
  
  const handleForceLogout = async (clientId, clientName) => {
    if (!window.confirm(`Force logout "${clientName}" from all devices?`)) return;
    
    try {
      await api.post(`/admin/clients/${clientId}/force-logout`);
      showSuccess('Client has been logged out from all devices');
    } catch (error) {
      showError(error.response?.data?.error || 'Failed to force logout');
    }
  };
  
  const handleDelete = async (clientId, clientName) => {
    if (!window.confirm(`Are you sure you want to delete "${clientName}"? This action cannot be undone.`)) return;
    
    try {
      await api.delete(`/admin/clients/${clientId}`);
      showSuccess('Client deleted successfully');
      loadClients();
    } catch (error) {
      showError(error.response?.data?.error || 'Failed to delete client');
    }
  };
  
  const formatDate = (date) => {
    if (!date) return 'Never';
    const d = new Date(date);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  
  return (
    <AdminLayoutEnhanced>
      <div className="max-w-7xl mx-auto space-y-6" data-testid="admin-clients-page">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2 flex items-center gap-3">
              <UserPlus className="text-genz-teal" size={32} />
              Client Management
            </h1>
            <p className="text-white/60">Manage client accounts and access</p>
          </div>
          <button
            onClick={() => navigate('/admin/clients/new')}
            className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-genz-teal to-genz-dark-teal text-white rounded-xl hover:shadow-lg hover:shadow-genz-teal/25 transition-all hover:scale-105"
            data-testid="create-client-btn"
          >
            <Plus size={20} />
            <span className="font-medium">Add Client</span>
          </button>
        </div>
        
        {/* Filters */}
        <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-6 space-y-4`}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Search */}
            <div className="md:col-span-2">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40" size={18} />
                <input
                  type="text"
                  placeholder="Search clients by name or email..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                  className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all"
                  data-testid="search-input"
                />
              </div>
            </div>
            
            {/* Status Filter */}
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all appearance-none cursor-pointer"
              style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.65rem' }}
              data-testid="status-filter"
            >
              <option value="" className="bg-[#1a1a22] text-white">All Status</option>
              <option value="active" className="bg-[#1a1a22] text-white">Active</option>
              <option value="disabled" className="bg-[#1a1a22] text-white">Disabled</option>
            </select>
          </div>
          
          <button
            onClick={handleSearch}
            className="w-full md:w-auto px-6 py-3 bg-gradient-to-r from-genz-teal to-genz-dark-teal text-white rounded-xl hover:shadow-lg hover:shadow-genz-teal/25 transition-all font-medium"
          >
            Apply Filters
          </button>
        </div>
        
        {/* Clients Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="animate-spin rounded-full h-16 w-16 border-4 border-genz-teal border-t-transparent mx-auto mb-4"></div>
              <p className="text-white/60">Loading clients...</p>
            </div>
          </div>
        ) : clients.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-12 text-center`}>
            <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-green-500/20 to-cyan-500/20 rounded-2xl flex items-center justify-center">
              <Users size={40} className="text-white/40" />
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">No clients found</h3>
            <p className="text-white/60 mb-6">Get started by adding your first client</p>
            <button
              onClick={() => navigate('/admin/clients/new')}
              className="px-6 py-3 bg-gradient-to-r from-genz-teal to-genz-dark-teal text-white rounded-xl hover:shadow-lg hover:shadow-genz-teal/25 transition-all"
            >
              Add Client
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {clients.map(client => (
                <div
                  key={client._id}
                  className={`group relative overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${
                    client.status === 'active' 
                      ? 'bg-gradient-to-br from-green-500/10 to-green-600/5 border border-green-500/30' 
                      : 'bg-gradient-to-br from-red-500/10 to-red-600/5 border border-red-500/30'
                  }`}
                  data-testid={`client-card-${client._id}`}
                >
                  {/* Glow effect on hover */}
                  <div className={`absolute top-0 right-0 w-40 h-40 ${client.status === 'active' ? 'bg-green-500' : 'bg-red-500'} opacity-0 group-hover:opacity-10 rounded-full blur-3xl transition-opacity duration-500`} />
                  
                  <div className="relative p-6">
                    <div className="flex items-start gap-4 mb-4">
                      <div className="w-16 h-16 bg-gradient-to-br from-genz-teal to-genz-dark-teal rounded-xl flex items-center justify-center flex-shrink-0 shadow-lg shadow-genz-teal/25">
                        <span className="text-white font-bold text-2xl">
                          {client.fullName?.charAt(0) || '?'}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-bold text-white mb-1 truncate group-hover:text-genz-teal transition-colors">
                          {client.fullName}
                        </h3>
                        <p className="text-sm text-white/60 truncate">{client.email}</p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                            client.status === 'active' 
                              ? 'bg-green-500/20 text-green-400' 
                              : 'bg-red-500/20 text-red-400'
                          }`}>
                            {client.status}
                          </span>
                          {client.isDeviceLocked && (
                            <span className="px-3 py-1 rounded-full text-xs font-medium bg-blue-500/20 text-blue-400 flex items-center gap-1">
                              <Smartphone size={12} />
                              Device Locked
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4 mb-4 p-4 bg-white/5 border border-white/10 rounded-xl">
                      <div>
                        <div className="flex items-center gap-2 text-white/50 text-xs mb-1">
                          <TrendingUp size={14} />
                          <span>Assignments</span>
                        </div>
                        <p className="text-white font-semibold">{client.activeAssignments || 0} active</p>
                      </div>
                      <div>
                        <div className="flex items-center gap-2 text-white/50 text-xs mb-1">
                          <Clock size={14} />
                          <span>Last Login</span>
                        </div>
                        <p className="text-white font-semibold text-sm">{formatDate(client.lastLoginAt)}</p>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => navigate(`/admin/clients/${client._id}/edit`)}
                        className="flex items-center justify-center gap-2 px-3 py-2.5 bg-blue-500/20 text-blue-400 rounded-xl hover:bg-blue-500/30 transition-colors text-sm font-medium"
                        data-testid={`edit-client-${client._id}`}
                      >
                        <Edit2 size={14} />
                        <span>Edit</span>
                      </button>
                      <button
                        onClick={() => navigate(`/admin/clients/${client._id}/assign`)}
                        className="flex items-center justify-center gap-2 px-3 py-2.5 bg-purple-500/20 text-purple-400 rounded-xl hover:bg-purple-500/30 transition-colors text-sm font-medium"
                      >
                        <TrendingUp size={14} />
                        <span>Assign</span>
                      </button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {client.isDeviceLocked && (
                        <button
                          onClick={() => handleDeviceReset(client._id, client.fullName)}
                          className="flex items-center justify-center gap-2 px-3 py-2.5 bg-yellow-500/20 text-yellow-400 rounded-xl hover:bg-yellow-500/30 transition-colors text-sm font-medium"
                          data-testid={`reset-device-${client._id}`}
                        >
                          <ShieldOff size={14} />
                          <span>Reset Device</span>
                        </button>
                      )}
                      <button
                        onClick={() => handleForceLogout(client._id, client.fullName)}
                        className="flex items-center justify-center gap-2 px-3 py-2.5 bg-genz-teal/10/20 text-genz-teal rounded-xl hover:bg-genz-teal/10/30 transition-colors text-sm font-medium"
                      >
                        <LogOut size={14} />
                        <span>Force Logout</span>
                      </button>
                      <button
                        onClick={() => handleDelete(client._id, client.fullName)}
                        className="flex items-center justify-center gap-2 px-3 py-2.5 bg-red-500/20 text-red-400 rounded-xl hover:bg-red-500/30 transition-colors text-sm font-medium"
                        data-testid={`delete-client-${client._id}`}
                      >
                        <Trash2 size={14} />
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            
            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 mt-8">
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: Math.max(1, prev.page - 1) }))}
                  disabled={pagination.page === 1}
                  className={`px-6 py-2.5 ${ADMIN_CARD_VARIANTS.default} rounded-xl text-white disabled:opacity-50 disabled:cursor-not-allowed hover:border-genz-teal/50 transition-colors`}
                >
                  Previous
                </button>
                <span className="text-white/60">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: Math.min(prev.totalPages, prev.page + 1) }))}
                  disabled={pagination.page >= pagination.totalPages}
                  className={`px-6 py-2.5 ${ADMIN_CARD_VARIANTS.default} rounded-xl text-white disabled:opacity-50 disabled:cursor-not-allowed hover:border-genz-teal/50 transition-colors`}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminClientsEnhanced;
