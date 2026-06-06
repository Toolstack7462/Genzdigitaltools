import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ClientLayoutEnhanced, { getCategoryTheme, CARD_VARIANTS } from '../../components/ClientLayoutEnhanced';
import { ArrowLeft, Package, ExternalLink, Clock, Info, Shield, CheckCircle2 } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const ClientToolDetail = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const { showError } = useToast();
  
  const [tool, setTool] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTool();
  }, [id]);

  const loadTool = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/client/tools/${id}`);
      setTool(res.data.tool);
    } catch (error) {
      showError('Failed to load tool');
      navigate('/client/tools');
    } finally {
      setLoading(false);
    }
  };

  const daysUntilExpiry = (endDate) => {
    if (!endDate) return null;
    const end = new Date(endDate);
    const now = new Date();
    return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
  };

  if (loading) {
    return (
      <ClientLayoutEnhanced>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-genz-teal border-t-transparent mx-auto mb-4"></div>
            <p className="text-white/60">Loading tool details...</p>
          </div>
        </div>
      </ClientLayoutEnhanced>
    );
  }

  if (!tool) {
    return (
      <ClientLayoutEnhanced>
        <div className="max-w-3xl mx-auto text-center py-16">
          <div className="w-24 h-24 mx-auto mb-6 bg-gradient-to-br from-purple-500/20 to-blue-500/20 rounded-2xl flex items-center justify-center">
            <Package size={48} className="text-white/55" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-4">Tool not found</h2>
          <button
            onClick={() => navigate('/client/tools')}
            className="text-genz-teal hover:underline font-medium"
          >
            ← Back to Tools
          </button>
        </div>
      </ClientLayoutEnhanced>
    );
  }

  const theme = getCategoryTheme(tool.category);
  const days = daysUntilExpiry(tool.accessEndDate);
  const isExpiringSoon = days !== null && days <= 7 && days > 0;

  return (
    <ClientLayoutEnhanced>
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Back Button */}
        <button
          onClick={() => navigate('/client/tools')}
          className="flex items-center gap-2 text-white/60 hover:text-white transition-colors group"
        >
          <ArrowLeft size={20} className="group-hover:-translate-x-1 transition-transform" />
          Back to Tools
        </button>

        {/* Main Tool Card */}
        <div className={`relative overflow-hidden rounded-3xl ${CARD_VARIANTS.elevated}`}>
          {/* Background glow */}
          <div className={`absolute top-0 right-0 w-80 h-80 bg-gradient-to-br ${theme.gradient} opacity-10 rounded-full blur-3xl`} />
          <div className={`absolute bottom-0 left-0 w-60 h-60 bg-gradient-to-br from-blue-500 to-purple-500 opacity-5 rounded-full blur-3xl`} />
          
          <div className="relative p-8">
            {/* Tool Header */}
            <div className="flex flex-col sm:flex-row items-start gap-6 mb-8">
              <div className={`w-24 h-24 bg-gradient-to-br ${theme.gradient} rounded-2xl flex items-center justify-center shadow-2xl flex-shrink-0`}>
                <Package size={48} className="text-white" />
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <h1 className="text-3xl font-bold text-white">{tool.name}</h1>
                  {tool.category && (
                    <span className={`px-4 py-1.5 ${theme.bg} ${theme.text} rounded-full text-sm font-medium`}>
                      {tool.category}
                    </span>
                  )}
                </div>
                <p className="text-white/60 text-lg leading-relaxed">
                  {tool.description || 'No description available'}
                </p>
              </div>
            </div>

            {/* Status Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
              {/* Access Status */}
              <div className={`${CARD_VARIANTS.green} rounded-xl p-4`}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-green-500/20 rounded-lg flex items-center justify-center">
                    <CheckCircle2 size={20} className="text-green-400" />
                  </div>
                  <div>
                    <p className="text-green-400 font-medium">Access Status</p>
                    <p className="text-white/60 text-sm">Active & Ready</p>
                  </div>
                </div>
              </div>

              {/* Expiry Info */}
              {tool.accessEndDate && (
                <div className={`${isExpiringSoon ? CARD_VARIANTS.yellow : CARD_VARIANTS.blue} rounded-xl p-4`}>
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 ${isExpiringSoon ? 'bg-yellow-500/20' : 'bg-blue-500/20'} rounded-lg flex items-center justify-center`}>
                      <Clock size={20} className={isExpiringSoon ? 'text-yellow-400' : 'text-blue-400'} />
                    </div>
                    <div>
                      <p className={`font-medium ${isExpiringSoon ? 'text-yellow-400' : 'text-blue-400'}`}>
                        {isExpiringSoon ? `${days} Days Left` : 'Valid Until'}
                      </p>
                      <p className="text-white/60 text-sm">
                        {new Date(tool.accessEndDate).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric'
                        })}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Action Button */}
            {tool.targetUrl && (
              <a
                href={tool.targetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-3 py-4 bg-gradient-to-r from-genz-teal to-genz-dark-teal text-white rounded-xl font-semibold text-lg hover:shadow-2xl hover:shadow-genz-teal/30 transition-all hover:scale-[1.01] active:scale-[0.99]"
                data-testid="open-tool-website-btn"
              >
                <ExternalLink size={22} />
                Open Tool Website
              </a>
            )}
          </div>
        </div>

        {/* Info Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {/* How to Use */}
          <div className={`${CARD_VARIANTS.indigo} rounded-2xl p-6`}>
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-indigo-500/20 rounded-xl flex items-center justify-center flex-shrink-0">
                <Info size={24} className="text-indigo-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white mb-2">How to Use</h3>
                <p className="text-white/60 text-sm leading-relaxed">
                  Click the &quot;Open Tool Website&quot; button above to access your assigned tool. 
                  Your access is granted by your administrator.
                </p>
              </div>
            </div>
          </div>

          {/* Security Info */}
          <div className={`${CARD_VARIANTS.cyan} rounded-2xl p-6`}>
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-cyan-500/20 rounded-xl flex items-center justify-center flex-shrink-0">
                <Shield size={24} className="text-cyan-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white mb-2">Secure Access</h3>
                <p className="text-white/60 text-sm leading-relaxed">
                  Your tool access is secured and monitored. Activity is logged for security purposes.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientToolDetail;
