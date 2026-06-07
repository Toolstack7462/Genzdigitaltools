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
  Wand2
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const AdminToolsEnhanced = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [pagination, setPagination] = useState({ page: 1, limit: 12, totalPages: 0 });
  
  const categories = ['AI', 'Academic', 'SEO', 'Productivity', 'Graphics & SEO', 'Text Humanizers', 'Career-Oriented', 'Miscellaneous', 'Other'];
  
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
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-genz-navy mb-2 flex items-center gap-3">
              <Sparkles className="text-genz-teal" size={32} />
              Tools Management
            </h1>
            <p className="text-genz-muted">Manage your tool library</p>
          </div>
          <button
            onClick={() => navigate('/admin/tools/new')}
            className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-genz-teal to-genz-dark-teal text-genz-navy rounded-xl hover:shadow-lg hover:shadow-genz-teal/25 transition-all hover:scale-105"
            data-testid="create-tool-btn"
          >
            <Plus size={20} />
            <span className="font-medium">Create Tool</span>
          </button>
        </div>
        
        {/* Filters */}
        <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-6 space-y-4`}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {/* Search */}
            <div className="md:col-span-2">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
                <input
                  type="text"
                  placeholder="Search tools by name or description..."
                  aria-label="Search tools by name or description"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                  className="w-full pl-11 pr-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all"
                  data-testid="search-input"
                />
              </div>
            </div>
            
            {/* Category Filter */}
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              aria-label="Filter tools by category"
              className="px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all appearance-none cursor-pointer"
              style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.65rem' }}
              data-testid="category-filter"
            >
              <option value="" className="bg-[#1a1a22] text-genz-navy">All Categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat} className="bg-[#1a1a22] text-genz-navy">{cat}</option>
              ))}
            </select>
            
            {/* Status Filter */}
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              aria-label="Filter tools by status"
              className="px-4 py-3 bg-genz-bg border border-genz-border rounded-xl text-genz-navy focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all appearance-none cursor-pointer"
              style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.65rem' }}
              data-testid="status-filter"
            >
              <option value="" className="bg-[#1a1a22] text-genz-navy">All Status</option>
              <option value="active" className="bg-[#1a1a22] text-genz-navy">Active</option>
              <option value="inactive" className="bg-[#1a1a22] text-genz-navy">Inactive</option>
            </select>
          </div>
          
          <button
            onClick={handleSearch}
            className="w-full md:w-auto px-6 py-3 bg-gradient-to-r from-genz-teal to-genz-dark-teal text-genz-navy rounded-xl hover:shadow-lg hover:shadow-genz-teal/25 transition-all font-medium"
          >
            Apply Filters
          </button>
        </div>
        
        {/* Tools Grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" aria-busy="true" aria-label="Loading tools">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-6 animate-pulse`}>
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-12 h-12 rounded-xl bg-genz-bg flex-shrink-0" />
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="h-4 w-3/5 rounded bg-genz-bg" />
                    <div className="h-3 w-2/5 rounded bg-white" />
                  </div>
                </div>
                <div className="space-y-2 mb-5">
                  <div className="h-3 w-full rounded bg-white" />
                  <div className="h-3 w-4/5 rounded bg-white" />
                </div>
                <div className="flex gap-2">
                  <div className="h-9 flex-1 rounded-xl bg-white" />
                  <div className="h-9 flex-1 rounded-xl bg-white" />
                </div>
              </div>
            ))}
          </div>
        ) : tools.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-12 text-center`}>
            <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-purple-500/20 to-blue-500/20 rounded-2xl flex items-center justify-center">
              <Package size={40} className="text-genz-muted" />
            </div>
            <h3 className="text-xl font-semibold text-genz-navy mb-2">No tools found</h3>
            <p className="text-genz-muted mb-6">Get started by creating your first tool</p>
            <button
              onClick={() => navigate('/admin/tools/new')}
              className="px-6 py-3 bg-gradient-to-r from-genz-teal to-genz-dark-teal text-genz-navy rounded-xl hover:shadow-lg hover:shadow-genz-teal/25 transition-all"
            >
              Create Tool
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {tools.map(tool => {
                const theme = getAdminCategoryTheme(tool.category);
                return (
                  <div
                    key={tool._id}
                    className={`group relative overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl bg-gradient-to-br ${theme.bg} border ${theme.border}`}
                    data-testid={`tool-card-${tool._id}`}
                  >
                    {/* Glow effect on hover */}
                    <div className={`absolute top-0 right-0 w-40 h-40 bg-gradient-to-br ${theme.gradient} opacity-0 group-hover:opacity-20 rounded-full blur-3xl transition-opacity duration-500`} />
                    
                    <div className="relative p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className={`w-12 h-12 bg-gradient-to-br ${theme.gradient} rounded-xl flex items-center justify-center shadow-lg`}>
                          <Package size={24} className="text-genz-navy" />
                        </div>
                        <div className="flex gap-2">
                          <span className={`px-3 py-1 ${theme.bg} ${theme.text} rounded-full text-xs font-medium`}>
                            {tool.category}
                          </span>
                        </div>
                      </div>
                      
                      <h3 className="text-lg font-bold text-genz-navy mb-2 group-hover:text-genz-teal transition-colors">
                        {tool.name}
                      </h3>
                      <p className="text-sm text-genz-muted line-clamp-2 mb-4 min-h-[40px]">
                        {tool.description || 'No description'}
                      </p>
                      
                      <div className="flex items-center gap-3 mb-4">
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          tool.status === 'active' 
                            ? 'bg-green-500/20 text-green-500' 
                            : 'bg-gray-500/20 text-gray-500'
                        }`}>
                          {tool.status}
                        </span>
                        {tool.assignmentCount !== undefined && (
                          <div className="flex items-center gap-1 text-xs text-genz-muted">
                            <TrendingUp size={12} />
                            <span>{tool.assignmentCount} assignments</span>
                          </div>
                        )}
                      </div>
                      
                      {tool.targetUrl && (
                        <a
                          href={tool.targetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-sm text-genz-teal hover:underline mb-4"
                        >
                          <ExternalLink size={14} />
                          <span className="truncate">View Tool</span>
                        </a>
                      )}
                      
                      <div className="flex items-center gap-2 pt-4 border-t border-genz-border">
                        <button
                          onClick={() => navigate(`/admin/tools/${tool._id}/edit`)}
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-500/20 text-blue-500 rounded-xl hover:bg-blue-500/30 transition-colors"
                          data-testid={`edit-tool-${tool._id}`}
                        >
                          <Edit2 size={16} />
                          <span className="text-sm font-medium">Edit</span>
                        </button>
                        <button
                          onClick={() => handleDelete(tool._id, tool.name)}
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-red-500/20 text-red-500 rounded-xl hover:bg-red-500/30 transition-colors"
                          data-testid={`delete-tool-${tool._id}`}
                        >
                          <Trash2 size={16} />
                          <span className="text-sm font-medium">Delete</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            
            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 mt-8">
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: Math.max(1, prev.page - 1) }))}
                  disabled={pagination.page === 1}
                  className={`px-6 py-2.5 ${ADMIN_CARD_VARIANTS.default} rounded-xl text-genz-navy disabled:opacity-50 disabled:cursor-not-allowed hover:border-genz-teal/50 transition-colors`}
                >
                  Previous
                </button>
                <span className="text-genz-muted">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: Math.min(prev.totalPages, prev.page + 1) }))}
                  disabled={pagination.page >= pagination.totalPages}
                  className={`px-6 py-2.5 ${ADMIN_CARD_VARIANTS.default} rounded-xl text-genz-navy disabled:opacity-50 disabled:cursor-not-allowed hover:border-genz-teal/50 transition-colors`}
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

export default AdminToolsEnhanced;
