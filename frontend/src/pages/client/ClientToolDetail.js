import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import ClientLayoutEnhanced, { getCategoryTheme, CARD_VARIANTS } from '../../components/ClientLayoutEnhanced';
import { ArrowLeft, Package, ExternalLink, Clock, Info, Shield, CheckCircle2, Loader2, AlertCircle, Lock, RefreshCw, AlertTriangle } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import { useExtension } from '../../hooks/useExtension';
import { daysUntilExpiry as expiryDays, isAccessExpired } from '../../utils/expiry';
import RenewPlanLink from '../../components/RenewPlanLink';

const ClientToolDetail = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const { showError, showWarning } = useToast();
  // Same secure opener as the dashboard: the extension fetches the latest
  // admin session bundle in the background, injects it, and opens the real
  // tool URL in a separate tab. The session bundle never reaches this page.
  const { bridgeReady, openTool } = useExtension();
  const [openState, setOpenState] = useState({}); // { loading, error }

  const [tool, setTool] = useState(null);
  const [loading, setLoading] = useState(true);

  /* ─── Access Now → extension-controlled open (inject session → open tool URL) ─ */
  const handleAccess = async () => {
    const toolId = tool?._id || tool?.id;
    if (!toolId) return;
    if (!bridgeReady) {
      setOpenState({ error: 'Install Extension' });
      return;
    }
    setOpenState({ loading: true });
    let result;
    try {
      result = await openTool(toolId);
    } catch (err) {
      result = { success: false, error: err?.message || 'open_failed' };
    }
    if (result?.success) {
      setOpenState({});
    } else if (result?.error === 'already_opening') {
      setOpenState({});
    } else {
      setOpenState({ error: result?.message || 'Could not open tool. Please try again.' });
      setTimeout(() => setOpenState({}), 8000);
    }
  };

  useEffect(() => {
    loadTool();
  }, [id]);

  // Urgent expiry warning toast — once per day (shares the dashboard's key so it
  // never double-fires the same day).
  useEffect(() => {
    if (!tool) return;
    const d = expiryDays(tool.accessEndDate, tool.daysUntilExpiry);
    if (tool.status === 'expired' || d === null || d < 1 || d > 3) return;
    const key = `expiry_urgent_toast_${new Date().toDateString()}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    showWarning(`Your access to ${tool.name} expires in ${d} day${d === 1 ? '' : 's'}. Please renew or contact support.`, 9000);
  }, [tool, showWarning]);

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

  // Inclusive end-of-day boundary, matching the backend (see utils/expiry.js).
  const daysUntilExpiry = (endDate, backendDays) => expiryDays(endDate, backendDays);

  if (loading) {
    return (
      <ClientLayoutEnhanced>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-genz-teal border-t-transparent mx-auto mb-4"></div>
            <p className="text-genz-muted">Loading tool details...</p>
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
            <Package size={48} className="text-genz-muted" />
          </div>
          <h2 className="text-2xl font-bold text-genz-navy mb-4">Tool not found</h2>
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
  const days = daysUntilExpiry(tool.accessEndDate, tool.daysUntilExpiry);
  const expired = tool.status === 'expired' || isAccessExpired(tool.accessEndDate);
  const isUrgent  = !expired && days !== null && days >= 0 && days <= 3;
  const isWarning = !expired && days !== null && days >= 4 && days <= 7;
  const isExpiringSoon = isUrgent || isWarning;
  const fmtFull = (d) => { const dt = new Date(d); return isNaN(dt.getTime()) ? null : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const endStr = fmtFull(tool.accessEndDate);
  const expiryText = expired
    ? `Expired${endStr ? ' · ' + endStr : ''}`
    : (days === 0 ? 'Expires today' : `Expires in ${days}d`) + (endStr ? ` · ${endStr}` : '');

  return (
    <ClientLayoutEnhanced>
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Back Button */}
        <button
          onClick={() => navigate('/client/tools')}
          className="flex items-center gap-2 text-[14px] text-genz-muted hover:text-genz-navy transition-colors group"
        >
          <ArrowLeft size={18} className="group-hover:-translate-x-1 transition-transform" />
          Back to Tools
        </button>

        {/* Main Tool Card */}
        <div className={`relative overflow-hidden rounded-2xl ${CARD_VARIANTS.elevated}`}>
          {/* Background glow */}
          <div className={`absolute top-0 right-0 w-64 h-64 bg-gradient-to-br ${theme.gradient} opacity-10 rounded-full blur-3xl`} />
          <div className={`absolute bottom-0 left-0 w-48 h-48 bg-gradient-to-br from-blue-500 to-purple-500 opacity-5 rounded-full blur-3xl`} />

          <div className="relative p-5 sm:p-6">
            {/* Tool Header */}
            <div className="flex items-start gap-4 mb-5">
              <div className={`w-16 h-16 bg-gradient-to-br ${theme.gradient} rounded-2xl flex items-center justify-center shadow-xl flex-shrink-0`}>
                <Package size={30} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2.5 mb-1.5">
                  <h1 className="font-heading text-2xl font-extrabold text-genz-navy">{tool.name}</h1>
                  {tool.category && (
                    <span className={`px-3 py-1 ${theme.bg} ${theme.text} rounded-full text-[12px] font-semibold`}>
                      {tool.category}
                    </span>
                  )}
                </div>
                <p className="text-genz-muted text-[14px] leading-relaxed">
                  {tool.description || 'No description available'}
                </p>
              </div>
            </div>

            {/* Status Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
              {/* Access Status */}
              <div className={`rounded-xl p-3.5 border ${expired ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
                <div className="flex items-center gap-2.5">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${expired ? 'bg-red-500/15' : 'bg-green-500/15'}`}>
                    {expired ? <Lock size={17} className="text-red-600" /> : <CheckCircle2 size={17} className="text-green-600" />}
                  </div>
                  <div>
                    <p className={`font-semibold text-[13px] ${expired ? 'text-red-600' : 'text-green-600'}`}>Access Status</p>
                    <p className="text-genz-muted text-[12px]">{expired ? 'Expired' : 'Active & Ready'}</p>
                  </div>
                </div>
              </div>

              {/* Valid Until / Expiry */}
              {tool.accessEndDate && (
                <div className={`rounded-xl p-3.5 border ${
                  expired || isUrgent ? 'bg-red-50 border-red-200' : isWarning ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'
                }`}>
                  <div className="flex items-center gap-2.5">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${expired || isUrgent ? 'bg-red-500/15' : isWarning ? 'bg-amber-500/15' : 'bg-blue-500/15'}`}>
                      {expired ? <Lock size={17} className="text-red-600" />
                        : isExpiringSoon ? <AlertTriangle size={17} className={isUrgent ? 'text-red-600' : 'text-amber-600'} />
                        : <Clock size={17} className="text-blue-600" />}
                    </div>
                    <div className="min-w-0">
                      <p className={`font-semibold text-[13px] ${expired || isUrgent ? 'text-red-600' : isWarning ? 'text-amber-600' : 'text-blue-600'}`}>
                        {expired ? 'Access Ended' : isExpiringSoon ? 'Expiring Soon' : 'Valid Until'}
                      </p>
                      <p className="text-genz-muted text-[12px] truncate">{isExpiringSoon ? expiryText : endStr}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Action — expired tools show Renew (Access disabled); otherwise the
                extension opens the admin-saved tool URL in a new tab. */}
            <div className="space-y-2">
              {expired ? (
                <RenewPlanLink
                  toolName={tool.name}
                  status="expired"
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-[15px] font-semibold border border-genz-blue/30 text-genz-blue hover:bg-genz-blue/[0.06] transition-all">
                  <RefreshCw size={18} /> Renew Access
                </RenewPlanLink>
              ) : tool.targetUrl ? (
                <>
                  <button
                    type="button"
                    onClick={handleAccess}
                    disabled={openState.loading}
                    className="w-full flex items-center justify-center gap-2.5 py-3 bg-gradient-to-r from-genz-teal to-genz-dark-teal text-white rounded-xl font-semibold text-[15px] hover:shadow-xl hover:shadow-genz-teal/30 transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed disabled:scale-100"
                    data-testid="open-tool-website-btn"
                  >
                    {openState.loading
                      ? <Loader2 size={18} className="animate-spin" />
                      : <ExternalLink size={18} />}
                    {openState.loading ? 'Opening Tool' : 'Access Now'}
                  </button>
                  {openState.error && (
                    <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200">
                      <AlertCircle size={15} className="text-red-500 flex-shrink-0 mt-0.5" />
                      <span className="text-[13px] text-red-600">{openState.error}</span>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* Info Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* How to Use */}
          <div className={`${CARD_VARIANTS.indigo} rounded-xl p-4`}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-indigo-500/20 rounded-lg flex items-center justify-center flex-shrink-0">
                <Info size={18} className="text-indigo-600" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-genz-navy mb-1">How to Use</h3>
                <p className="text-genz-muted text-[12.5px] leading-relaxed">
                  Click &quot;Access Now&quot; above to open your assigned tool in a new tab with your latest session applied automatically.
                </p>
              </div>
            </div>
          </div>

          {/* Security Info */}
          <div className={`${CARD_VARIANTS.cyan} rounded-xl p-4`}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-cyan-500/20 rounded-lg flex items-center justify-center flex-shrink-0">
                <Shield size={18} className="text-cyan-600" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-genz-navy mb-1">Secure Access</h3>
                <p className="text-genz-muted text-[12.5px] leading-relaxed">
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
