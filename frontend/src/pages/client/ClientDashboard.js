import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ClientLayout from '../../components/ClientLayout';
import { Package, Clock, AlertTriangle, CheckCircle2, X } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import { authService } from '../../services/authService';
import { daysUntilExpiry as expiryDays } from '../../utils/expiry';

const ClientDashboard = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const [tools, setTools] = useState([]);
  const [expiringTools, setExpiringTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showExpiryWarning, setShowExpiryWarning] = useState(false);
  
  const user = authService.getCurrentUser();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [toolsRes, expiringRes] = await Promise.all([
        api.get('/client/tools'),
        api.get('/client/assignments/expiring')
      ]);
      
      setTools(toolsRes.data.tools || []);
      setExpiringTools(expiringRes.data.expiring || []);
      
      // Show warning if there are expiring tools
      if (expiringRes.data.expiring?.length > 0) {
        const dismissed = localStorage.getItem('expiry_warning_dismissed');
        const dismissedTime = dismissed ? new Date(dismissed) : null;
        const now = new Date();
        
        // Show again after 24 hours
        if (!dismissedTime || (now - dismissedTime) > 24 * 60 * 60 * 1000) {
          setShowExpiryWarning(true);
        }
      }
    } catch (error) {
      showError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const dismissWarning = () => {
    setShowExpiryWarning(false);
    localStorage.setItem('expiry_warning_dismissed', new Date().toISOString());
  };

  // Inclusive end-of-day boundary, matching the backend (see utils/expiry.js).
  const daysUntilExpiry = (endDate, backendDays) => expiryDays(endDate, backendDays);

  if (loading) {
    return (
      <ClientLayout>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-genz-teal border-t-transparent"></div>
        </div>
      </ClientLayout>
    );
  }

  return (
    <ClientLayout>
      {/* Expiry Warning Popup */}
      {showExpiryWarning && expiringTools.length > 0 && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={dismissWarning} />
          <div className="relative bg-white/[0.04] border border-yellow-500/50 rounded-2xl p-6 max-w-md w-full animate-in fade-in zoom-in duration-200">
            <button
              onClick={dismissWarning}
              className="absolute top-4 right-4 text-genz-muted hover:text-white"
            >
              <X size={20} />
            </button>
            
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 bg-yellow-500/20 rounded-full flex items-center justify-center">
                <AlertTriangle size={24} className="text-yellow-400" />
              </div>
              <h3 className="text-xl font-semibold text-white">Access Expiring Soon</h3>
            </div>
            
            <p className="text-genz-muted mb-4">
              The following tool(s) will expire within 3 days:
            </p>
            
            <div className="space-y-2 mb-6">
              {expiringTools.map((item, idx) => (
                <div key={idx} className="flex items-center justify-between p-3 bg-yellow-500/10 rounded-lg">
                  <span className="text-white font-medium">{item.tool?.name || 'Unknown Tool'}</span>
                  <span className="text-yellow-400 text-sm">
                    {daysUntilExpiry(item.endDate, item.daysUntilExpiry)} days left
                  </span>
                </div>
              ))}
            </div>
            
            <p className="text-sm text-genz-muted mb-4">
              Please contact your administrator to extend access.
            </p>
            
            <button
              onClick={dismissWarning}
              className="w-full py-2 bg-yellow-500 text-black rounded-full font-medium hover:bg-yellow-400 transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">
            Welcome back, {user?.fullName || 'User'}!
          </h1>
          <p className="text-genz-muted">Access your assigned tools and manage your account</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white/[0.04] border border-white/10 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 bg-blue-500 rounded-lg flex items-center justify-center">
                <Package size={24} className="text-white" />
              </div>
            </div>
            <div className="text-3xl font-bold text-white mb-1">{tools.length}</div>
            <div className="text-sm text-genz-muted">Assigned Tools</div>
          </div>
          
          <div className="bg-white/[0.04] border border-white/10 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 bg-green-500 rounded-lg flex items-center justify-center">
                <CheckCircle2 size={24} className="text-white" />
              </div>
            </div>
            <div className="text-3xl font-bold text-white mb-1">
              {tools.filter(t => t.status === 'active').length}
            </div>
            <div className="text-sm text-genz-muted">Active Tools</div>
          </div>
          
          <div className="bg-white/[0.04] border border-white/10 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className={`w-12 h-12 ${expiringTools.length > 0 ? 'bg-yellow-500' : 'bg-gray-500'} rounded-lg flex items-center justify-center`}>
                <Clock size={24} className="text-white" />
              </div>
            </div>
            <div className="text-3xl font-bold text-white mb-1">{expiringTools.length}</div>
            <div className="text-sm text-genz-muted">Expiring Soon</div>
          </div>
        </div>

        {/* Quick Access */}
        <div className="bg-white/[0.04] border border-white/10 rounded-xl p-6">
          <h2 className="text-xl font-bold text-white mb-4">Quick Access</h2>
          
          {tools.length === 0 ? (
            <div className="text-center py-8">
              <Package size={48} className="mx-auto mb-4 text-genz-muted opacity-50" />
              <h3 className="text-lg font-medium text-white mb-2">No tools assigned</h3>
              <p className="text-genz-muted">Contact your administrator to get tool access</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {tools.slice(0, 6).map((tool) => (
                <button
                  key={tool._id}
                  onClick={() => navigate(`/client/tools/${tool._id}`)}
                  className="p-4 bg-white/5 border border-white/10 rounded-xl text-left hover:border-genz-teal transition-all group"
                  data-testid={`quick-tool-${tool._id}`}
                >
                  <div className="flex items-center gap-3">
                    <Package size={24} className="text-genz-teal" />
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-white group-hover:text-genz-teal transition-colors truncate">
                        {tool.name}
                      </h3>
                      <p className="text-xs text-genz-muted truncate">{tool.description}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          
          {tools.length > 6 && (
            <button
              onClick={() => navigate('/client/tools')}
              className="mt-4 text-genz-teal hover:underline text-sm"
            >
              View all {tools.length} tools →
            </button>
          )}
        </div>
      </div>
    </ClientLayout>
  );
};

export default ClientDashboard;
