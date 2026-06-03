import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ClientLayoutEnhanced from '../../components/ClientLayoutEnhanced';
import { 
  Package, 
  Search, 
  Filter, 
  Calendar,
  Clock,
  ArrowRight,
  ExternalLink,
  AlertTriangle,
  CheckCircle
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const ClientToolsEnhanced = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  
  const categories = ['All', 'AI', 'Academic', 'SEO', 'Productivity', 'Graphics & SEO', 'Text Humanizers', 'Career-Oriented', 'Miscellaneous'];
  
  useEffect(() => { loadTools(); }, []); // Initial load

  // FIX26: Re-fetch when filters change (debounced)
  useEffect(() => {
    const t = setTimeout(() => loadTools(searchTerm, selectedCategory), 350);
    return () => clearTimeout(t);
  }, [searchTerm, selectedCategory]);
  
  // FIX26: Server-side filtering — pass params to backend instead of fetching all
  const loadTools = async (search = searchTerm, category = selectedCategory) => {
    try {
      setLoading(true);
      const params = {};
      if (search) params.search = search;
      if (category && category !== 'All') params.category = category;
      const response = await api.get('/client/tools', { params });
      setTools(response.data.tools || []);
    } catch (error) {
      console.error('Load tools error:', error);
      showError('Failed to load tools');
    } finally {
      setLoading(false);
    }
  };
  
  const formatDate = (dateStr) => {
    if (!dateStr) return 'No expiry';
    const date = new Date(dateStr);
    const options = { day: 'numeric', month: 'short', year: 'numeric' };
    return date.toLocaleDateString('en-GB', options);
  };
  
  const getDaysLeft = (endDate) => {
    if (!endDate) return null;
    const now = new Date();
    const end = new Date(endDate);
    const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
    return daysLeft;
  };
  
  const getStatusColor = (daysLeft) => {
    if (daysLeft === null) return 'bg-green-500/20 text-green-400';
    if (daysLeft <= 3) return 'bg-red-500/20 text-red-400';
    if (daysLeft <= 7) return 'bg-yellow-500/20 text-yellow-400';
    return 'bg-green-500/20 text-green-400';
  };
  
  const getCategoryColor = (category) => {
    const colors = {
      'AI': 'from-purple-500 to-purple-600',
      'Academic': 'from-blue-500 to-blue-600',
      'SEO': 'from-green-500 to-green-600',
      'Productivity': 'from-yellow-500 to-yellow-600',
      'Graphics & SEO': 'from-pink-500 to-pink-600',
      'Text Humanizers': 'from-indigo-500 to-indigo-600',
      'Career-Oriented': 'from-orange-500 to-orange-600'
    };
    return colors[category] || 'from-gray-500 to-gray-600';
  };
  
  // FIX26: Filtering done server-side; tools is already filtered
  const filteredTools = tools;
  
  if (loading) {
    return (
      <ClientLayoutEnhanced>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-genz-teal border-t-transparent mx-auto mb-4"></div>
            <p className="text-genz-muted">Loading your tools...</p>
          </div>
        </div>
      </ClientLayoutEnhanced>
    );
  }
  
  return (
    <ClientLayoutEnhanced>
      <div className="max-w-7xl mx-auto space-y-6" data-testid="client-tools-page">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">My Tools</h1>
          <p className="text-genz-muted">Access and manage your assigned tools</p>
        </div>
        
        {/* Filters */}
        <div className="bg-white/[0.04] border border-white/10 rounded-2xl p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
              <input
                type="text"
                placeholder="Search tools..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                data-testid="search-input"
              />
            </div>
            
            {/* Category Filter */}
            <div className="relative">
              <Filter className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={18} />
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full pl-10 pr-10 py-2 bg-[#000c20] border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-genz-teal/30 focus:border-genz-teal transition-all appearance-none cursor-pointer hover:border-genz-muted"
                style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.75rem center', backgroundSize: '0.65rem' }}
                data-testid="category-filter"
              >
                {categories.map(cat => (
                  <option key={cat} value={cat} className="bg-[#000c20] text-white">{cat}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        
        {/* Tools Grid */}
        {filteredTools.length === 0 ? (
          <div className="bg-white/[0.04] border border-white/10 rounded-2xl p-12 text-center">
            <Package size={64} className="mx-auto mb-4 text-genz-muted opacity-50" />
            <h3 className="text-xl font-semibold text-white mb-2">No tools found</h3>
            <p className="text-genz-muted">Try adjusting your search or filters</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredTools.map(tool => {
              const daysLeft = getDaysLeft(tool.endDate);
              const statusColor = getStatusColor(daysLeft);
              
              return (
                <button
                  key={tool._id}
                  onClick={() => navigate(`/client/tools/${tool._id}`)}
                  className="group relative overflow-hidden p-6 bg-white/[0.04] border border-white/10 rounded-2xl text-left hover:border-genz-teal transition-all hover:-translate-y-1 hover:shadow-xl"
                  data-testid={`tool-card-${tool._id}`}
                >
                  {/* Background gradient */}
                  <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-br ${getCategoryColor(tool.category)} opacity-10 rounded-full blur-2xl`} />
                  
                  <div className="relative">
                    {/* Tool Icon & Name */}
                    <div className="flex items-center gap-3 mb-4">
                      <div className={`w-12 h-12 bg-gradient-to-br ${getCategoryColor(tool.category)} rounded-xl flex items-center justify-center flex-shrink-0`}>
                        <Package size={24} className="text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-white group-hover:text-genz-teal transition-colors truncate text-lg">
                          {tool.name}
                        </h3>
                        <p className="text-xs text-genz-muted truncate">{tool.category}</p>
                      </div>
                    </div>
                    
                    {/* Description */}
                    <p className="text-sm text-genz-muted line-clamp-2 mb-4">
                      {tool.description || 'No description available'}
                    </p>
                    
                    {/* Date Range */}
                    <div className="space-y-2 mb-4 p-3 bg-white/5 rounded-lg border border-white/10">
                      {tool.startDate && (
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-genz-muted flex items-center gap-1">
                            <Calendar size={12} />
                            Start Date
                          </span>
                          <span className="text-white font-medium">{formatDate(tool.startDate)}</span>
                        </div>
                      )}
                      {tool.endDate && (
                        <>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-genz-muted flex items-center gap-1">
                              <Clock size={12} />
                              Expires On
                            </span>
                            <span className="text-white font-medium">{formatDate(tool.endDate)}</span>
                          </div>
                          
                          {/* Days Left Badge */}
                          <div className="flex items-center justify-center pt-2 border-t border-white/10">
                            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${statusColor} text-xs font-semibold`}>
                              {daysLeft <= 3 && <AlertTriangle size={12} />}
                              {daysLeft > 3 && <CheckCircle size={12} />}
                              <span>
                                {daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left` : 'Expired'}
                              </span>
                            </div>
                          </div>
                        </>
                      )}
                      {!tool.endDate && (
                        <div className="text-center text-xs text-green-400 font-medium">
                          No expiry date
                        </div>
                      )}
                    </div>
                    
                    {/* Action Button */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-genz-teal font-medium">View Details</span>
                      <ArrowRight size={16} className="text-genz-teal group-hover:translate-x-1 transition-transform" />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientToolsEnhanced;