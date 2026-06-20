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
  Clock,
  UserPlus,
  TrendingUp,
  Package,
  MoreHorizontal,
  X
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import AdminModal from '../../components/admin/AdminModal';
import AssignmentManager from '../../components/admin/AssignmentManager';
import ClientDetailPanel from '../../components/admin/ClientDetailPanel';
import { SUGGESTED_TAGS, TagChip } from '../../components/admin/ClientTags';

const AdminClientsEnhanced = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [pagination, setPagination] = useState({ page: 1, limit: 20, totalPages: 0, total: 0 });
  const [manageClient, setManageClient] = useState(null);
  const [modalTab, setModalTab] = useState('tools'); // per-client modal: 'tools' | 'profile'
  const [actionsOpenId, setActionsOpenId] = useState(null); // mobile: which card's overflow menu is open

  // Always open the client modal on the Tools tab.
  useEffect(() => { if (manageClient) setModalTab('tools'); }, [manageClient]);

  useEffect(() => {
    loadClients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.page, selectedStatus, selectedTag]);

  const loadClients = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: pagination.page,
        limit: pagination.limit
      });

      if (searchTerm) params.append('search', searchTerm);
      if (selectedStatus) params.append('status', selectedStatus);
      if (selectedTag) params.append('tag', selectedTag);

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

  // Compact, consistent action button (icon-only on the table, icon+label on cards).
  const ActionBtn = ({ onClick, title, tone, icon: Icon, label, testId }) => {
    const tones = {
      blue:   'text-genz-blue hover:bg-genz-blue/10',
      teal:   'text-genz-teal hover:bg-genz-teal/10',
      amber:  'text-amber-500 hover:bg-amber-500/10',
      red:    'text-red-500 hover:bg-red-500/10',
      slate:  'text-genz-muted hover:bg-genz-navy/5',
    };
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        data-testid={testId}
        className={`inline-flex items-center justify-center gap-1.5 h-8 ${label ? 'px-2.5' : 'w-8'} rounded-lg border border-genz-border bg-genz-bg ${tones[tone]} transition-colors text-[13px] font-medium`}
      >
        <Icon size={14} />
        {label && <span>{label}</span>}
      </button>
    );
  };

  const StatusBadge = ({ client }) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={`ds-badge ${client.status === 'active' ? 'ds-badge-success' : 'ds-badge-danger'}`}>
        <span className="dot" /> {client.status}
      </span>
      {client.isDeviceLocked && (
        <span className="ds-badge ds-badge-info" title="Device locked"><Smartphone size={11} /></span>
      )}
    </span>
  );

  const Avatar = ({ client, size = 'sm' }) => (
    <div
      className={`${size === 'sm' ? 'w-9 h-9 text-sm' : 'w-10 h-10 text-base'} rounded-lg flex items-center justify-center flex-shrink-0 text-white font-bold`}
      style={{ background: 'var(--gradient-cta)', boxShadow: '0 6px 14px -8px rgba(37,99,235,0.6)' }}
    >
      {client.fullName?.charAt(0) || '?'}
    </div>
  );

  const RowActions = ({ client }) => (
    <div className="flex items-center justify-end gap-1.5">
      <ActionBtn tone="blue" icon={Edit2} title="Edit client" testId={`edit-client-${client._id}`}
                 onClick={() => navigate(`/admin/clients/${client._id}/edit`)} />
      <ActionBtn tone="teal" icon={Package} title="Manage assigned tools" testId={`manage-tools-${client._id}`}
                 onClick={() => setManageClient(client)} />
      <ActionBtn tone="teal" icon={TrendingUp} title="Assign tools"
                 onClick={() => navigate(`/admin/clients/${client._id}/assign`)} />
      {client.isDeviceLocked && (
        <ActionBtn tone="amber" icon={ShieldOff} title="Reset device" testId={`reset-device-${client._id}`}
                   onClick={() => handleDeviceReset(client._id, client.fullName)} />
      )}
      <ActionBtn tone="amber" icon={LogOut} title="Force logout"
                 onClick={() => handleForceLogout(client._id, client.fullName)} />
      <ActionBtn tone="red" icon={Trash2} title="Delete client" testId={`delete-client-${client._id}`}
                 onClick={() => handleDelete(client._id, client.fullName)} />
    </div>
  );

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-7xl mx-auto space-y-5" data-testid="admin-clients-page">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl font-extrabold text-genz-navy mb-0.5 flex items-center gap-2.5">
              <span className="ds-icon-grad w-9 h-9 rounded-xl flex items-center justify-center"><UserPlus size={18} /></span>
              Client Management
            </h1>
            <p className="text-sm text-genz-muted">Manage client accounts and access</p>
          </div>
          <button
            onClick={() => navigate('/admin/clients/new')}
            className="btn-grad flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold"
            data-testid="create-client-btn"
          >
            <Plus size={16} />
            <span>Add Client</span>
          </button>
        </div>

        {/* Filters — single compact row */}
        <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4`}>
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted" size={16} />
              <input
                type="text"
                placeholder="Search clients by name or email..."
                aria-label="Search clients by name or email"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all"
                data-testid="search-input"
              />
            </div>
            <select
              value={selectedStatus}
              onChange={(e) => { setSelectedStatus(e.target.value); setPagination(p => ({ ...p, page: 1 })); }}
              aria-label="Filter clients by status"
              className="px-3.5 py-2.5 text-sm bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all appearance-none cursor-pointer md:w-44"
              style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.85rem center', backgroundSize: '0.6rem' }}
              data-testid="status-filter"
            >
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
            <select
              value={selectedTag}
              onChange={(e) => { setSelectedTag(e.target.value); setPagination(p => ({ ...p, page: 1 })); }}
              aria-label="Filter clients by tag"
              className="px-3.5 py-2.5 text-sm bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all appearance-none cursor-pointer md:w-44"
              style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.85rem center', backgroundSize: '0.6rem' }}
              data-testid="tag-filter"
            >
              <option value="">All Tags</option>
              {SUGGESTED_TAGS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button
              onClick={handleSearch}
              className="btn-grad px-5 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap"
            >
              Apply
            </button>
          </div>
        </div>

        {/* Result count */}
        {!loading && clients.length > 0 && (
          <p className="text-xs text-genz-muted px-1">
            Showing {clients.length}{pagination.total ? ` of ${pagination.total}` : ''} client{clients.length === 1 ? '' : 's'}
          </p>
        )}

        {/* Clients */}
        {loading ? (
          <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4 space-y-3`} aria-busy="true" aria-label="Loading clients">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 animate-pulse">
                <div className="w-9 h-9 rounded-lg bg-genz-navy/10 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/4 rounded bg-genz-navy/10" />
                  <div className="h-2.5 w-1/3 rounded bg-genz-navy/10" />
                </div>
                <div className="h-5 w-16 rounded-full bg-genz-navy/10" />
                <div className="h-8 w-28 rounded-lg bg-genz-navy/10" />
              </div>
            ))}
          </div>
        ) : clients.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-12 text-center`}>
            <div className="w-16 h-16 mx-auto mb-5 bg-gradient-to-br from-green-500/20 to-cyan-500/20 rounded-2xl flex items-center justify-center">
              <Users size={32} className="text-genz-muted" />
            </div>
            <h3 className="text-lg font-bold text-genz-navy mb-1.5">No clients found</h3>
            <p className="text-sm text-genz-muted mb-5">Get started by adding your first client</p>
            <button
              onClick={() => navigate('/admin/clients/new')}
              className="btn-grad inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold"
            >
              <Plus size={16} /> Add Client
            </button>
          </div>
        ) : (
          <>
            {/* Desktop: compact table */}
            <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl overflow-hidden hidden md:block`}>
              <div className="overflow-x-auto">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>Status</th>
                      <th>Assignments</th>
                      <th>Last Login</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map(client => (
                      <tr key={client._id} data-testid={`client-card-${client._id}`}>
                        <td>
                          <div className="flex items-center gap-3 min-w-0">
                            <Avatar client={client} />
                            <div className="min-w-0">
                              <p className="font-semibold text-genz-navy text-sm truncate">{client.fullName}</p>
                              <p className="text-xs text-genz-muted truncate">{client.email}</p>
                              {client.tags?.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {client.tags.slice(0, 4).map(t => <TagChip key={t} tag={t} />)}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td><StatusBadge client={client} /></td>
                        <td className="whitespace-nowrap text-sm">
                          <span className="font-semibold text-genz-navy">{client.activeAssignments || 0}</span>
                          <span className="text-genz-muted"> active</span>
                        </td>
                        <td className="whitespace-nowrap text-xs text-genz-muted">{formatDate(client.lastLoginAt)}</td>
                        <td><RowActions client={client} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile: compact card list */}
            <div className="md:hidden space-y-2.5">
              {clients.map(client => (
                <div key={client._id} className="ds-card p-3.5" data-testid={`client-card-m-${client._id}`}>
                  <div className="flex items-start gap-3">
                    <Avatar client={client} size="md" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-genz-navy text-sm truncate">{client.fullName}</p>
                      <p className="text-xs text-genz-muted truncate mb-1.5">{client.email}</p>
                      <StatusBadge client={client} />
                      {client.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {client.tags.slice(0, 5).map(t => <TagChip key={t} tag={t} />)}
                        </div>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-xs text-genz-muted">
                        <span className="flex items-center gap-1"><TrendingUp size={12} /> {client.activeAssignments || 0} active</span>
                        <span className="flex items-center gap-1 truncate"><Clock size={12} /> {formatDate(client.lastLoginAt)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-genz-border">
                    {/* Primary actions stay visible; secondary ones collapse behind "More"
                        so the card never wraps into a cramped multi-row button block. */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ActionBtn tone="blue" icon={Edit2} label="Edit" title="Edit client"
                                 onClick={() => navigate(`/admin/clients/${client._id}/edit`)} />
                      <ActionBtn tone="teal" icon={Package} label="Tools" title="Manage assigned tools"
                                 onClick={() => setManageClient(client)} />
                      <ActionBtn tone="teal" icon={TrendingUp} label="Assign" title="Assign tools"
                                 onClick={() => navigate(`/admin/clients/${client._id}/assign`)} />
                      <ActionBtn
                        tone="slate"
                        icon={actionsOpenId === client._id ? X : MoreHorizontal}
                        label={actionsOpenId === client._id ? 'Less' : 'More'}
                        title={actionsOpenId === client._id ? 'Hide actions' : 'More actions'}
                        onClick={() => setActionsOpenId(prev => (prev === client._id ? null : client._id))}
                      />
                    </div>
                    {actionsOpenId === client._id && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        {client.isDeviceLocked && (
                          <ActionBtn tone="amber" icon={ShieldOff} label="Reset" title="Reset device"
                                     onClick={() => handleDeviceReset(client._id, client.fullName)} />
                        )}
                        <ActionBtn tone="amber" icon={LogOut} label="Logout" title="Force logout"
                                   onClick={() => handleForceLogout(client._id, client.fullName)} />
                        <ActionBtn tone="red" icon={Trash2} label="Delete" title="Delete client"
                                   onClick={() => handleDelete(client._id, client.fullName)} />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-6">
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: Math.max(1, prev.page - 1) }))}
                  disabled={pagination.page === 1}
                  className={`px-4 py-2 text-sm ${ADMIN_CARD_VARIANTS.default} rounded-xl text-genz-navy disabled:opacity-50 disabled:cursor-not-allowed hover:border-genz-teal/50 transition-colors`}
                >
                  Previous
                </button>
                <span className="text-sm text-genz-muted">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: Math.min(prev.totalPages, prev.page + 1) }))}
                  disabled={pagination.page >= pagination.totalPages}
                  className={`px-4 py-2 text-sm ${ADMIN_CARD_VARIANTS.default} rounded-xl text-genz-navy disabled:opacity-50 disabled:cursor-not-allowed hover:border-genz-teal/50 transition-colors`}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}

        {/* Per-client modal: assigned tools + profile/timeline */}
        <AdminModal
          isOpen={!!manageClient}
          onClose={() => setManageClient(null)}
          title={manageClient ? manageClient.fullName : 'Client'}
          subtitle={manageClient?.email}
          icon={Users}
          maxWidth="max-w-4xl"
        >
          {manageClient && (
            <>
              <div className="flex items-center gap-1.5 mb-4 border-b border-genz-border">
                {[
                  { key: 'tools', label: 'Assigned Tools', Icon: Package },
                  { key: 'profile', label: 'Profile & Timeline', Icon: Clock },
                ].map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setModalTab(key)}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
                      modalTab === key
                        ? 'border-genz-teal text-genz-navy'
                        : 'border-transparent text-genz-muted hover:text-genz-navy'
                    }`}
                    data-testid={`client-modal-tab-${key}`}
                  >
                    <Icon size={15} /> {label}
                  </button>
                ))}
              </div>
              {modalTab === 'tools' ? (
                <AssignmentManager clientId={manageClient._id} onChanged={loadClients} />
              ) : (
                <ClientDetailPanel
                  clientId={manageClient._id}
                  onEdit={(c) => navigate(`/admin/clients/${c._id}/edit`)}
                />
              )}
            </>
          )}
        </AdminModal>
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminClientsEnhanced;
