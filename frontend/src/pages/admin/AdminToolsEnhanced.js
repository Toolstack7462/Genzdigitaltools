import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminLayoutEnhanced, { getAdminCategoryTheme, ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import { 
  Package, 
  Plus, 
  Search, 
  Edit2, 
  Trash2, 
  ExternalLink,
  TrendingUp,
  Sparkles,
  Wand2,
  Users
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import AdminModal from '../../components/admin/AdminModal';
import AssignmentManager from '../../components/admin/AssignmentManager';

const AdminToolsEnhanced = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [pagination, setPagination] = useState({ page: 1, limit: 16, totalPages: 0 });
  const [manageTool, setManageTool] = useState(null);

  const categories =['AI', 'Academic', 'SEO', 'Productivity', 'Graphics & SEO', 'Text Humanizers', 'Career-Oriented', 'Miscellaneous', 'Other'];
  
  useEffect(() => {
    loadTools();
  }, [pagination.page, selectedCategory, selectedStatus]);
  
  const loadTools = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: pagination.page,
        limit: pagination.limit
      });
      
      if (searchTerm) params.append('search', searchTerm);
      if (selectedCategory) params.append('category', selectedCategory);
      if (selectedStatus) params.append('status', selectedStatus);
      
      const response = await api.get(`/admin/tools?${params}`);
      setTools(response.data.tools || []);
      setPagination(prev => ({ ...prev, ...response.data.pagination }));
    } catch (error) {
      console.error('Load tools error:', error);
      showError('Failed to load tools');
    } finally {
      setLoading(false);
    }
  };
  
  const handleSearch = () => {
    setPagination(prev => ({ ...prev, page: 1 }));
    loadTools();
  };
  
  const handleDelete = async (toolId, toolName) => {
    if (!window.confirm(`Are you sure you want to delete "${toolName}"?`)) return;
    
    try {
      await api.delete(`/admin/tools/${toolId}`);
      showSuccess('Tool deleted successfully');
      loadTools();
    } catch (error) {
      showError(error.response?.data?.error || 'Failed to delete tool');
    }
  };
  
  return (
    <AdminLayoutEnhanced>
      <div className="max-w-7xl mx-auto space-y-6" data-testid="admin-tools-page">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="font-heading text-[22px] sm:text-[26px] font-extrabold text-genz-navy mb-0.5 flex items-center gap-2.5">
              <span className="ds-icon-grad w-9 h-9 rounded-xl flex items-center justify-center"><Sparkles size={18} /></span>
              Tools Management
            </h1>
            <p className="text-genz-muted text-sm">Manage your tool library</p>
          </div>
          <button
            onClick={() => navigate('/admin/tools/new')}
            className="btn-grad flex items-center gap-2 px-4 py-2.5 rounded-[14px] text-sm font-bold"
            data-testid="create-tool-btn"
          >
            <Plus size={16} />
            <span>Create Tool</span>
          </button>
        </div>
        
        {/* Filters */}
        <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4 space-y-3`}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {/* Search */}
            <div className="md:col-span-2">
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-genz-muted" size={16} />
                <input
                  type="text"
                  placeholder="Search tools by name or description..."
                  aria-label="Search tools by name or description"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                  className="w-full pl-10 pr-4 py-2.5 bg-genz-bg border border-genz-border rounded-xl text-sm text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all"
                  data-testid="search-input"
                />
              </div>
            </div>
            
            {/* Category Filter */}
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              aria-label="Filter tools by category"
              className="px-4 py-2.5 bg-genz-bg border border-genz-border rounded-xl text-sm text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all appearance-none cursor-pointer"
              style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.65rem' }}
              data-testid="category-filter"
            >
              <option value="">All Categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            
            {/* Status Filter */}
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              aria-label="Filter tools by status"
              className="px-4 py-2.5 bg-genz-bg border border-genz-border rounded-xl text-sm text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all appearance-none cursor-pointer"
              style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.65rem' }}
              data-testid="status-filter"
            >
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          
          <button
            onClick={handleSearch}
            className="btn-grad w-full md:w-auto px-5 py-2.5 rounded-[14px] text-sm font-bold"
          >
            Apply Filters
          </button>
        </div>
        
        {/* Tools Grid */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" aria-busy="true" aria-label="Loading tools">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4 animate-pulse`}>
                <div className="flex items-center gap-2.5 mb-2.5">
                  <div className="w-9 h-9 rounded-lg bg-genz-bg flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-3/5 rounded bg-genz-bg" />
                    <div className="h-2.5 w-2/5 rounded bg-white" />
                  </div>
                </div>
                <div className="space-y-1.5 mb-3">
                  <div className="h-2.5 w-full rounded bg-white" />
                  <div className="h-2.5 w-4/5 rounded bg-white" />
                </div>
                <div className="h-8 w-full rounded-lg bg-white mb-2" />
                <div className="flex gap-2">
                  <div className="h-8 flex-1 rounded-lg bg-white" />
                  <div className="h-8 flex-1 rounded-lg bg-white" />
                </div>
              </div>
            ))}
          </div>
        ) : tools.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-12 text-center`}>
            <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-purple-500/20 to-blue-500/20 rounded-2xl flex items-center justify-center">
              <Package size={40} className="text-genz-muted" />
            </div>
            <h3 className="text-xl font-bold text-genz-navy mb-2">No tools found</h3>
            <p className="text-genz-muted mb-6">Get started by creating your first tool</p>
            <button
              onClick={() => navigate('/admin/tools/new')}
              className="btn-grad inline-flex items-center gap-2 px-6 py-3 rounded-[14px] text-[15px] font-bold"
            >
              <Plus size={18} /> Create Tool
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {tools.map(tool => {
                const theme = getAdminCategoryTheme(tool.category);
                return (
                  <div
                    key={tool._id}
                    className="ds-card ds-stat group relative overflow-hidden flex flex-col"
                    data-testid={`tool-card-${tool._id}`}
                  >
                    <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${theme.gradient}`} />

                    <div className="relative p-4 flex flex-col flex-1">
                      {/* Title row: icon + name + category */}
                      <div className="flex items-center gap-2.5 mb-2.5">
                        <div className={`w-9 h-9 shrink-0 bg-gradient-to-br ${theme.gradient} rounded-lg flex items-center justify-center shadow-sm`}>
                          <Package size={16} className="text-white" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[14px] font-bold text-genz-navy truncate group-hover:text-genz-teal transition-colors" title={tool.name}>
                            {tool.name}
                          </h3>
                          <span className={`inline-block mt-0.5 px-2 py-0.5 ${theme.bg} ${theme.text} rounded-full text-[10px] font-semibold`}>
                            {tool.category}
                          </span>
                        </div>
                      </div>

                      {/* Description */}
                      <p className="text-[12px] text-genz-muted line-clamp-2 mb-2.5 min-h-[32px]">
                        {tool.description || 'No description'}
                      </p>

                      {/* Status + assigned count */}
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <span className={`ds-badge ${tool.status === 'active' ? 'ds-badge-success' : 'ds-badge-neutral'}`}>
                          <span className="dot" /> {tool.status}
                        </span>
                        <button
                          type="button"
                          onClick={() => setManageTool(tool)}
                          className="flex items-center gap-1 text-[11px] text-genz-muted hover:text-genz-teal transition-colors"
                          title="View assigned clients"
                        >
                          <TrendingUp size={12} />
                          <span>{tool.assignmentCount ?? 0} assigned</span>
                        </button>
                      </div>

                      {/* Actions (kept: Manage Assignments, Edit, Delete, View Tool) */}
                      <div className="mt-auto space-y-2">
                        <button
                          onClick={() => setManageTool(tool)}
                          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-genz-teal/10 text-genz-teal rounded-lg hover:bg-genz-teal/20 transition-colors text-[13px] font-semibold"
                          data-testid={`manage-assignments-${tool._id}`}
                        >
                          <Users size={14} />
                          <span>Manage</span>
                          <span className="px-1.5 py-0.5 rounded-full bg-genz-teal/20 text-[10px] font-bold">{tool.assignmentCount ?? 0}</span>
                        </button>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => navigate(`/admin/tools/${tool._id}/edit`)}
                            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-blue-500/15 text-blue-500 rounded-lg hover:bg-blue-500/25 transition-colors text-xs font-medium"
                            data-testid={`edit-tool-${tool._id}`}
                          >
                            <Edit2 size={14} /> Edit
                          </button>
                          <button
                            onClick={() => handleDelete(tool._id, tool.name)}
                            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-red-500/15 text-red-500 rounded-lg hover:bg-red-500/25 transition-colors text-xs font-medium"
                            data-testid={`delete-tool-${tool._id}`}
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                          {tool.targetUrl && (
                            <a
                              href={tool.targetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-genz-bg text-genz-navy rounded-lg hover:bg-genz-teal/10 hover:text-genz-teal transition-colors text-xs font-medium"
                              title="Open tool in new tab"
                            >
                              <ExternalLink size={14} /> View
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            
            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-6">
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: Math.max(1, prev.page - 1) }))}
                  disabled={pagination.page === 1}
                  className={`px-4 py-2 text-sm font-semibold ${ADMIN_CARD_VARIANTS.default} rounded-xl text-genz-navy disabled:opacity-50 disabled:cursor-not-allowed hover:border-genz-teal/50 transition-colors`}
                >
                  Previous
                </button>
                <span className="text-genz-muted text-sm tabular-nums">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: Math.min(prev.totalPages, prev.page + 1) }))}
                  disabled={pagination.page >= pagination.totalPages}
                  className={`px-4 py-2 text-sm font-semibold ${ADMIN_CARD_VARIANTS.default} rounded-xl text-genz-navy disabled:opacity-50 disabled:cursor-not-allowed hover:border-genz-teal/50 transition-colors`}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}

        {/* Manage assignments modal */}
        <AdminModal
          isOpen={!!manageTool}
          onClose={() => setManageTool(null)}
          title={manageTool ? `${manageTool.name} — Assignments` : 'Assignments'}
          subtitle="Clients with access to this tool"
          icon={Users}
          maxWidth="max-w-4xl"
        >
          {manageTool && (
            <AssignmentManager toolId={manageTool._id} onChanged={loadTools} />
          )}
        </AdminModal>
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminToolsEnhanced;
