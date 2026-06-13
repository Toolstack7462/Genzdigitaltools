import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import { Plus, Search, Edit2, Trash2, Users, RotateCcw, Package, Eye, ChevronLeft, ChevronRight, Filter, AlertTriangle } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import ConfirmModal from '../../components/ConfirmModal';

const AdminClients = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, client: null });
  const [resetModal, setResetModal] = useState({ open: false, client: null });
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0 });

  useEffect(() => {
    loadClients();
  }, [pagination.page, statusFilter]);

  const loadClients = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: pagination.page,
        limit: pagination.limit
      });
      if (statusFilter) params.append('status', statusFilter);
      
      const res = await api.get(`/admin/clients?${params}`);
      setClients(res.data.clients || []);
      setPagination(prev => ({ 
        ...prev, 
        total: res.data.pagination?.totalCount || res.data.clients?.length || 0 
      }));
    } catch (error) {
      showError('Failed to load clients');
    } finally {
      setLoading(false);
    }
  };

  const toggleStatus = async (client) => {
    try {
      const newStatus = client.status === 'active' ? 'disabled' : 'active';
      await api.put(`/admin/clients/${client._id}`, { status: newStatus });
      setClients(clients.map(c => c._id === client._id ? { ...c, status: newStatus } : c));
      showSuccess(`Client ${newStatus === 'active' ? 'activated' : 'disabled'}`);
    } catch (error) {
      showError('Failed to update status');
    }
  };

  const handleDelete = async () => {
    if (!deleteModal.client) return;
    try {
      await api.delete(`/admin/clients/${deleteModal.client._id}`);
      setClients(clients.filter(c => c._id !== deleteModal.client._id));
      showSuccess('Client deleted successfully');
      setDeleteModal({ open: false, client: null });
    } catch (error) {
      showError('Failed to delete client');
    }
  };

  const handleResetDevice = async () => {
    if (!resetModal.client) return;
    try {
      await api.post(`/admin/clients/${resetModal.client._id}/reset-device`);
      showSuccess('Device binding reset successfully');
      setResetModal({ open: false, client: null });
    } catch (error) {
      showError('Failed to reset device');
    }
  };

  const filteredClients = clients.filter(client =>
    client.fullName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    client.email?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalPages = Math.ceil(pagination.total / pagination.limit);

  const getExpiryStatus = (client) => {
    if (!client.subscriptionEndDate) return null;
    const days = Math.ceil((new Date(client.subscriptionEndDate) - new Date()) / (1000 * 60 * 60 * 24));
    if (days <= 0) return { label: 'Expired', color: 'text-red-400 bg-red-400/10' };
    if (days <= 7) return { label: `${days}d left`, color: 'text-yellow-400 bg-yellow-400/10' };
    if (days <= 30) return { label: `${days}d left`, color: 'text-genz-teal bg-genz-teal/10/10' };
    return null;
  };

  if (loading && clients.length === 0) {
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
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Clients</h1>
            <p className="text-genz-muted text-sm">Manage client accounts and tool access</p>
          </div>
          <button
            onClick={() => navigate('/admin/clients/new')}
            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-orange text-white rounded-lg font-medium hover:opacity-90 transition-opacity text-sm"
            data-testid="create-client-btn"
          >
            <Plus size={18} />
            Add Client
          </button>
        </div>

        {/* Filters Bar */}
        <div className="bg-white/[0.04] border border-white/10 rounded-xl p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
              <input
                type="text"
                placeholder="Search by name or email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors text-sm"
                data-testid="search-clients-input"
              />
            </div>
            <div className="flex items-center gap-3">
              <Filter size={18} className="text-genz-muted" />
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPagination(prev => ({ ...prev, page: 1 }));
                }}
                className="px-4 py-2.5 bg-[#000c20] border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-genz-teal/30 focus:border-genz-teal transition-all text-sm appearance-none cursor-pointer hover:border-genz-muted min-w-[120px]"
                style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.75rem center', backgroundSize: '0.65rem' }}
                data-testid="status-filter"
              >
                <option value="" className="bg-[#000c20] text-white">All Status</option>
                <option value="active" className="bg-[#000c20] text-white">Active</option>
                <option value="disabled" className="bg-[#000c20] text-white">Disabled</option>
              </select>
              <select
                value={pagination.limit}
                onChange={(e) => setPagination(prev => ({ ...prev, limit: parseInt(e.target.value), page: 1 }))}
                className="px-4 py-2.5 bg-[#000c20] border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-genz-teal/30 focus:border-genz-teal transition-all text-sm appearance-none cursor-pointer hover:border-genz-muted min-w-[100px]"
                style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.75rem center', backgroundSize: '0.65rem' }}
              >
                <option value="10" className="bg-[#000c20] text-white">10 / page</option>
                <option value="25" className="bg-[#000c20] text-white">25 / page</option>
                <option value="50" className="bg-[#000c20] text-white">50 / page</option>
              </select>
            </div>
          </div>
        </div>

        {/* Clients Table */}
        {filteredClients.length === 0 ? (
          <div className="bg-white/[0.04] border border-white/10 rounded-xl p-12 text-center">
            <Users size={48} className="mx-auto mb-4 text-genz-muted opacity-50" />
            <h3 className="text-lg font-medium text-white mb-2">
              {searchTerm || statusFilter ? 'No clients found' : 'No clients yet'}
            </h3>
            <p className="text-genz-muted mb-4 text-sm">
              {searchTerm || statusFilter ? 'Try adjusting your filters' : 'Add your first client to get started'}
            </p>
            {!searchTerm && !statusFilter && (
              <button
                onClick={() => navigate('/admin/clients/new')}
                className="px-5 py-2 bg-gradient-orange text-white rounded-lg font-medium hover:opacity-90 text-sm"
              >
                Add Client
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white/[0.04] border border-white/10 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-genz-muted uppercase tracking-wider">Client</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-genz-muted uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-genz-muted uppercase tracking-wider">Tools</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-genz-muted uppercase tracking-wider">Subscription</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-genz-muted uppercase tracking-wider">Created</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-genz-muted uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10/50">
                  {filteredClients.map((client) => {
                    const expiry = getExpiryStatus(client);
                    return (
                      <tr 
                        key={client._id} 
                        className="hover:bg-white/5 transition-colors"
                        data-testid={`client-row-${client._id}`}
                      >
                        <td className="px-4 py-3">
                          <div>
                            <div className="font-medium text-white text-sm">{client.fullName}</div>
                            <div className="text-xs text-genz-muted">{client.email}</div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => toggleStatus(client)}
                            className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer ${
                              client.status === 'active'
                                ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                                : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                            }`}
                            title="Click to toggle status"
                          >
                            {client.status}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 text-sm text-white">
                            <Package size={14} className="text-genz-muted" />
                            {client.assignmentCount || 0}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {expiry ? (
                            <span className={`px-2 py-1 text-xs rounded-full flex items-center gap-1 w-fit ${expiry.color}`}>
                              <AlertTriangle size={12} />
                              {expiry.label}
                            </span>
                          ) : (
                            <span className="text-xs text-genz-muted">-</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-genz-muted">
                          {new Date(client.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => navigate(`/admin/clients/${client._id}/assign`)}
                              className="p-1.5 text-genz-muted hover:text-blue-400 hover:bg-blue-400/10 rounded transition-colors"
                              title="Manage Tool Assignments"
                            >
                              <Package size={16} />
                            </button>
                            <button
                              onClick={() => setResetModal({ open: true, client })}
                              className="p-1.5 text-genz-muted hover:text-yellow-400 hover:bg-yellow-400/10 rounded transition-colors"
                              title="Reset Device Binding"
                            >
                              <RotateCcw size={16} />
                            </button>
                            <button
                              onClick={() => navigate(`/admin/clients/${client._id}/edit`)}
                              className="p-1.5 text-genz-muted hover:text-genz-teal hover:bg-genz-teal/10 rounded transition-colors"
                              title="Edit"
                            >
                              <Edit2 size={16} />
                            </button>
                            <button
                              onClick={() => setDeleteModal({ open: true, client })}
                              className="p-1.5 text-genz-muted hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                              title="Delete"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-white/10 bg-white/5">
                <span className="text-xs text-genz-muted">
                  Showing {((pagination.page - 1) * pagination.limit) + 1} - {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                    disabled={pagination.page === 1}
                    className="p-1.5 text-genz-muted hover:text-white disabled:opacity-50 disabled:cursor-not-allowed rounded hover:bg-white/5"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  {[...Array(Math.min(5, totalPages))].map((_, i) => {
                    const pageNum = i + 1;
                    return (
                      <button
                        key={pageNum}
                        onClick={() => setPagination(prev => ({ ...prev, page: pageNum }))}
                        className={`w-8 h-8 text-sm rounded ${
                          pagination.page === pageNum
                            ? 'bg-genz-teal text-white'
                            : 'text-genz-muted hover:text-white hover:bg-white/5'
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                    disabled={pagination.page >= totalPages}
                    className="p-1.5 text-genz-muted hover:text-white disabled:opacity-50 disabled:cursor-not-allowed rounded hover:bg-white/5"
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, client: null })}
        onConfirm={handleDelete}
        title="Delete Client"
        message={`Are you sure you want to delete "${deleteModal.client?.fullName}"? This will also remove all their tool assignments.`}
        confirmText="Delete"
        confirmStyle="danger"
      />

      <ConfirmModal
        isOpen={resetModal.open}
        onClose={() => setResetModal({ open: false, client: null })}
        onConfirm={handleResetDevice}
        title="Reset Device Binding"
        message={`Reset device binding for "${resetModal.client?.fullName}"? They will be able to login from a new device.`}
        confirmText="Reset"
        confirmStyle="warning"
      />
    </AdminLayout>
  );
};

export default AdminClients;
