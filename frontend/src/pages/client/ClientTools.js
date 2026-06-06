import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ClientLayoutEnhanced, { getCategoryTheme, CARD_VARIANTS } from '../../components/ClientLayoutEnhanced';
import { Package, Search, Clock, ExternalLink, AlertTriangle, Sparkles } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const ClientTools = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  useEffect(() => {
    loadTools();
  }, []);

  const loadTools = async () => {
    try {
      setLoading(true);
      const res = await api.get('/client/tools');
      setTools(res.data.tools || []);
    } catch (error) {
      showError('Failed to load tools');
    } finally {
      setLoading(false);
    }
  };

  const daysUntilExpiry = (endDate) => {
    if (!endDate) return null;
    const end = new Date(endDate);
    const now = new Date();
    const diff = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
    return diff;
  };

  // Get unique categories
  const categories = ['all', ...new Set(tools.map(t => t.category).filter(Boolean))];

  const filteredTools = tools.filter(tool => {
    const matchesSearch = tool.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tool.description?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || tool.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  if (loading) {
    return (
      <ClientLayoutEnhanced>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-genz-teal border-t-transparent mx-auto mb-4"></div>
            <p className="text-white/60">Loading your tools...</p>
          </div>
        </div>
      </ClientLayoutEnhanced>
    );
  }

  return (
    <ClientLayoutEnhanced>
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2 flex items-center gap-3">
              <Sparkles className="text-genz-teal" size={32} />
              My Tools
            </h1>
            <p className="text-white/60">Access and manage your assigned tools</p>
          </div>
          <div className={`${CARD_VARIANTS.purple} rounded-2xl px-6 py-3`}>
            <div className="text-3xl font-bold text-white">{tools.length}</div>
            <div className="text-sm text-purple-400 font-medium">Total Tools</div>
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div className={`${CARD_VARIANTS.default} rounded-2xl p-4 sm:p-6`}>
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/55" size={20} />
              <input
                type="text"
                placeholder="Search tools..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/40 focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all"
                data-testid="search-tools-input"
              />
            </div>
            
            {/* Category Filter */}
            {categories.length > 2 && (
              <div className="flex gap-2 overflow-x-auto pb-2 sm:pb-0">
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
                      selectedCategory === cat
                        ? 'bg-gradient-to-r from-genz-teal to-genz-dark-teal text-white shadow-lg shadow-genz-teal/25'
                        : 'bg-white/5 text-white/60 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {cat === 'all' ? 'All Tools' : cat}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Tools Grid */}
        {filteredTools.length === 0 ? (
          <div className={`${CARD_VARIANTS.elevated} rounded-2xl p-12 text-center`}>
            <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-purple-500/20 to-blue-500/20 rounded-2xl flex items-center justify-center">
              <Package size={40} className="text-white/55" />
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">
              {searchTerm ? 'No tools found' : 'No tools assigned'}
            </h3>
            <p className="text-white/60 max-w-md mx-auto">
              {searchTerm ? 'Try a different search term or clear filters' : 'Contact your administrator to get tool access'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredTools.map((tool) => {
              const days = daysUntilExpiry(tool.accessEndDate);
              const isExpiringSoon = days !== null && days <= 3 && days > 0;
              const isExpired = days !== null && days <= 0;
              const theme = getCategoryTheme(tool.category);
              
              return (
                <div
                  key={tool._id}
                  className={`group relative overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${
                    isExpired 
                      ? 'opacity-60 bg-gradient-to-br from-red-500/10 to-red-600/5 border border-red-500/30' 
                      : isExpiringSoon 
                        ? 'bg-gradient-to-br from-yellow-500/10 to-yellow-600/5 border border-yellow-500/30'
                        : `bg-gradient-to-br ${theme.bg} border ${theme.border}`
                  }`}
                  data-testid={`tool-card-${tool._id}`}
                >
                  {/* Glow effect on hover */}
                  <div className={`absolute top-0 right-0 w-40 h-40 bg-gradient-to-br ${theme.gradient} opacity-0 group-hover:opacity-20 rounded-full blur-3xl transition-opacity duration-500`} />
                  
                  <div className="relative p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div className={`w-14 h-14 bg-gradient-to-br ${theme.gradient} rounded-xl flex items-center justify-center shadow-lg`}>
                        <Package size={28} className="text-white" />
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {isExpired && (
                          <span className="px-3 py-1 bg-red-500/20 text-red-400 text-xs font-medium rounded-full">
                            Expired
                          </span>
                        )}
                        {isExpiringSoon && !isExpired && (
                          <span className="px-3 py-1 bg-yellow-500/20 text-yellow-400 text-xs font-medium rounded-full flex items-center gap-1">
                            <AlertTriangle size={12} />
                            {days} days left
                          </span>
                        )}
                        {tool.category && !isExpired && !isExpiringSoon && (
                          <span className={`px-3 py-1 ${theme.bg} ${theme.text} text-xs font-medium rounded-full`}>
                            {tool.category}
                          </span>
                        )}
                      </div>
                    </div>
                    
                    <h3 className="text-lg font-bold text-white mb-2 group-hover:text-genz-teal transition-colors">
                      {tool.name}
                    </h3>
                    <p className="text-sm text-white/60 line-clamp-2 mb-4 min-h-[40px]">
                      {tool.description || 'No description available'}
                    </p>
                    
                    {tool.accessEndDate && (
                      <div className="flex items-center gap-2 text-xs text-white/50 mb-4">
                        <Clock size={14} />
                        Access until: {new Date(tool.accessEndDate).toLocaleDateString()}
                      </div>
                    )}
                    
                    <div className="flex gap-2">
                      <button
                        onClick={() => navigate(`/client/tools/${tool._id}`)}
                        disabled={isExpired}
                        className={`flex-1 py-3 rounded-xl font-medium text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                          isExpired 
                            ? 'bg-white/10 text-white/50'
                            : 'bg-gradient-to-r from-genz-teal to-genz-dark-teal text-white hover:shadow-lg hover:shadow-genz-teal/25 hover:scale-[1.02]'
                        }`}
                        data-testid={`use-tool-${tool._id}`}
                      >
                        {isExpired ? 'Expired' : 'Use Tool'}
                      </button>
                      {tool.targetUrl && (
                        <a
                          href={tool.targetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-3 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 hover:border-genz-teal/50 transition-all"
                          title="Open tool website"
                        >
                          <ExternalLink size={18} className="text-white/60" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientTools;
