import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ClientLayoutEnhanced, { getCategoryTheme, CARD_VARIANTS } from '../../components/ClientLayoutEnhanced';
import {
  Package, Clock, CheckCircle2, X, TrendingUp, Calendar, ExternalLink,
  Lock, Chrome, Download, Zap, Shield, User, Star, Search, Filter,
  Bot, BookOpen, BarChart3, Palette, Code2, Globe, AlertTriangle,
  Sparkles, ArrowRight, RefreshCw, Loader2, AlertCircle, ShieldCheck
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import { authService } from '../../services/authService';
import { useExtension } from '../../hooks/useExtension';


/* ─── Extension detection is handled by useExtension() bridge heartbeat.
   No Chrome extension ID is needed in the React build. */
/* ─── Tool Card Component ────────────────────────────────────────── */
const ToolCard = ({ tool, onOpen, openState }) => {
  const theme = getCategoryTheme(tool.category);
  const isExpired  = tool.status === 'expired';
  const isExpiring = tool.daysUntilExpiry !== undefined && tool.daysUntilExpiry <= 7 && !isExpired;
  const needsExt   = tool.accessMethod === 'extension';

  const getBadges = () => {
    const badges = [];
    if (tool.isFeatured) badges.push({ label: 'Featured', color: 'bg-yellow-500/20 text-yellow-300' });
    if (tool.isNew)      badges.push({ label: 'New',      color: 'bg-green-500/20 text-green-300'  });
    if (tool.isPopular)  badges.push({ label: 'Popular',  color: 'bg-purple-500/20 text-purple-300' });
    if (tool.isAI)       badges.push({ label: 'AI',       color: 'bg-blue-500/20 text-blue-300'    });
    return badges;
  };

  return (
    <div className={`relative group rounded-2xl p-5 border transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl ${
      isExpired
        ? 'opacity-60 border-red-500/20 bg-red-500/5'
        : `${CARD_VARIANTS.default} hover:border-white/20`
    }`}>
      {/* Status indicator */}
      {isExpiring && (
        <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
      )}

      {/* Tool header */}
      <div className="flex items-start justify-between mb-3">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-white font-black text-base bg-gradient-to-br ${theme.gradient}`}>
          {tool.name?.charAt(0) || '?'}
        </div>
        <div className="flex flex-wrap gap-1 justify-end">
          {getBadges().slice(0, 2).map(b => (
            <span key={b.label} className={`text-xs px-2 py-0.5 rounded-full font-medium ${b.color}`}>
              {b.label}
            </span>
          ))}
        </div>
      </div>

      {/* Tool info */}
      <h3 className="font-bold text-white text-sm mb-0.5 truncate group-hover:text-genz-teal transition-colors">
        {tool.name}
      </h3>
      <p className={`text-xs font-medium mb-2 ${theme.text}`}>{tool.category}</p>
      {tool.shortDescription && (
        <p className="text-xs text-white/50 leading-relaxed mb-3 line-clamp-2">{tool.shortDescription}</p>
      )}

      {/* Status / expiry */}
      {isExpiring && (
        <div className="flex items-center gap-1 text-xs text-yellow-400 mb-3">
          <AlertTriangle size={11} />
          <span>Expires in {tool.daysUntilExpiry}d</span>
        </div>
      )}
      {isExpired && (
        <div className="flex items-center gap-1 text-xs text-red-400 mb-3">
          <Lock size={11} />
          <span>Subscription expired</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-auto pt-2">
        {!isExpired ? (
          <button
            onClick={() => onOpen && onOpen(tool)}
            disabled={openState?.loading}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold text-genz-deep-navy transition-all hover:opacity-90 hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
            {openState?.loading
              ? <Loader2 size={13} className="animate-spin" />
              : <ExternalLink size={13} />
            }
            {openState?.loading ? 'Opening…' : 'Access'}
          </button>
        ) : (
          <Link to="/contact"
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-medium border border-genz-teal/30 text-genz-teal hover:bg-genz-teal/10 transition-all">
            <RefreshCw size={13} />
            Renew
          </Link>
        )}
        <Link to={`/client/tools/${tool._id}`}
              className="px-3 py-2 rounded-xl text-xs border border-white/10 text-white/60 hover:border-white/30 hover:text-white transition-all">
          Info
        </Link>
      {openState?.error && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
          <AlertCircle size={11} className="flex-shrink-0 mt-0.5" />
          <span>{openState.error}</span>
        </div>
      )}
      </div>
    </div>
  );
};

/* ─── MAIN DASHBOARD ─────────────────────────────────────────────── */
const ClientDashboardEnhanced = () => {
  const navigate = useNavigate();
  const { showError } = useToast();
  const [tools, setTools] = useState([]);
  const [expiringTools, setExpiringTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showExpiryWarning, setShowExpiryWarning] = useState(false);
  const [showExtensionBanner, setShowExtensionBanner] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');

  const user = authService.getCurrentUser();
  const { status: extConnStatus, bridgeReady, openTool, connectExtension, grantScanConsent, getScanStatus } = useExtension();
  const extStatus = extConnStatus; // bridge-based status, no extension ID required
  const [scanConsent, setScanConsent] = useState(null); // null=unknown, true=given, false=not given
  const [toolOpenStates, setToolOpenStates] = useState({}); // toolId → {loading,error,message}

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [toolsRes, expiringRes] = await Promise.all([
        api.get('/client/tools'),
        api.get('/client/assignments/expiring')
      ]);
      setTools(toolsRes.data.tools || []);
      setExpiringTools(expiringRes.data.expiring || []);
      if (expiringRes.data.expiring?.length > 0) {
        const dismissed = localStorage.getItem('expiry_warning_dismissed');
        const dismissedTime = dismissed ? new Date(dismissed) : null;
        const hoursSinceDismissed = dismissedTime
          ? (new Date() - dismissedTime) / (1000 * 60 * 60) : 999;
        if (hoursSinceDismissed > 24) setShowExpiryWarning(true);
      }
    } catch (err) {
      if (err.response?.status === 401) navigate('/client/login');
      else showError('Failed to load your tools');
    } finally {
      setLoading(false);
    }
  }, [navigate, showError]);

  useEffect(() => { loadData(); }, [loadData]);

  // Check scanner consent once bridge is ready
  useEffect(() => {
    if (!bridgeReady) return;
    getScanStatus().then(s => setScanConsent(!!s?.consentGiven)).catch(() => {});
  }, [bridgeReady, getScanStatus]);

  const dismissExpiryWarning = () => {
    setShowExpiryWarning(false);
    localStorage.setItem('expiry_warning_dismissed', new Date().toISOString());
  };

  // Derive stats
  const activeTools   = tools.filter(t => t.status !== 'expired');
  const expiredTools  = tools.filter(t => t.status === 'expired');
  const featuredTools = tools.filter(t => t.isFeatured && t.status !== 'expired').slice(0, 4);

  // Unique categories
  const categories = ['All', ...new Set(tools.map(t => t.category).filter(Boolean))];

  // Filter tools
  const filteredTools = tools.filter(t => {
    const matchesSearch = !searchQuery ||
      t.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.category?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.shortDescription?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = activeFilter === 'All' || t.category === activeFilter;
    return matchesSearch && matchesFilter;
  });

  /* ─── handleOpenTool ─ */
  const handleOpenTool = async (tool) => {
    const toolId = tool._id || tool.toolId;
    if (!toolId) return;

    // Extension is the required background access helper. Do not open targetUrl directly
    // from the website because credentials/session data must stay inside the extension.
    if (!bridgeReady) {
      setToolOpenStates(prev => ({
        ...prev,
        [toolId]: { error: 'Extension not detected yet. Reload the extension, refresh this dashboard, then click Access again.' }
      }));
      return;
    }

    setToolOpenStates(prev => ({ ...prev, [toolId]: { loading: true } }));
    if (!extConnStatus?.connected) {
      try { await connectExtension(); } catch (_) {}
    }
    const result = await openTool(toolId);
    if (result.success) {
      setToolOpenStates(prev => ({ ...prev, [toolId]: {} }));
    } else {
      const msg = result.actionableError || result.message || result.error || 'Could not open tool';
      setToolOpenStates(prev => ({ ...prev, [toolId]: { error: msg } }));
      // Auto-clear error after 8s
      setTimeout(() => setToolOpenStates(prev => {
        const copy = { ...prev };
        delete copy[toolId];
        return copy;
      }), 8000);
    }
  };

  /* ─── Loading State ─ */
  if (loading) {
    return (
      <ClientLayoutEnhanced>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
          <div className="w-16 h-16 rounded-full border-4 border-genz-teal border-t-transparent animate-spin" />
          <p className="text-genz-muted text-sm">Loading your dashboard...</p>
        </div>
      </ClientLayoutEnhanced>
    );
  }

  /* ─── Main Render ─ */
  return (
    <ClientLayoutEnhanced>
      <div className="space-y-6">

        {/* ── Expiry Warning Banner ── */}
        {showExpiryWarning && expiringTools.length > 0 && (
          <div className="flex items-start gap-3 p-4 rounded-2xl border border-yellow-500/30 bg-yellow-500/10">
            <AlertTriangle size={18} className="text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-yellow-300 font-semibold text-sm mb-1">
                {expiringTools.length} tool{expiringTools.length > 1 ? 's' : ''} expiring soon
              </p>
              <p className="text-yellow-400/70 text-xs">
                {expiringTools.slice(0, 3).map(t => t.toolName).join(', ')}
                {expiringTools.length > 3 && ` +${expiringTools.length - 3} more`}
              </p>
            </div>
            <button onClick={dismissExpiryWarning} className="text-yellow-400/60 hover:text-yellow-300 transition-colors">
              <X size={16} />
            </button>
          </div>
        )}

        {/* ── Welcome Header ── */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles size={16} className="text-genz-teal" />
              <span className="text-genz-teal text-sm font-medium">Welcome back</span>
            </div>
            <h1 className="text-3xl font-black text-white">
              {user?.fullName ? user.fullName.split(' ')[0] : 'Member'}'s Dashboard
            </h1>
            <p className="text-genz-muted text-sm mt-1">
              You have access to <span className="text-genz-teal font-semibold">{activeTools.length}</span> premium tools
            </p>
          </div>
          <div className="flex items-center gap-3">
            {user?.expiryDate && (
              <div className="text-right">
                <p className="text-xs text-genz-muted">Subscription</p>
                <p className="text-sm font-semibold text-white">
                  {new Date(user.expiryDate) > new Date()
                    ? `Active until ${new Date(user.expiryDate).toLocaleDateString()}`
                    : <span className="text-red-400">Expired</span>
                  }
                </p>
              </div>
            )}
            <Link to="/client/profile"
                  className="w-10 h-10 rounded-xl flex items-center justify-center border border-genz-teal/20 hover:border-genz-teal/50 hover:bg-genz-teal/10 transition-all"
                  title="My Profile">
              <User size={18} className="text-genz-teal" />
            </Link>
          </div>
        </div>

        {/* ── Stats Row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { icon: Package,  value: tools.length,          label: 'Total Tools',    color: 'text-genz-teal'   },
            { icon: CheckCircle2, value: activeTools.length, label: 'Active Tools',  color: 'text-green-400'   },
            { icon: Clock,    value: expiringTools.length,   label: 'Expiring Soon', color: 'text-yellow-400'  },
            { icon: Lock,     value: expiredTools.length,    label: 'Expired',       color: 'text-red-400'     },
          ].map(({ icon: Icon, value, label, color }) => (
            <div key={label} className={`${CARD_VARIANTS.default} p-4 rounded-2xl`}>
              <Icon size={18} className={`${color} mb-2`} />
              <div className="text-2xl font-black text-white">{value}</div>
              <div className="text-xs text-genz-muted">{label}</div>
            </div>
          ))}
        </div>

        {/* ── Chrome Extension Banner ── */}
        {showExtensionBanner && (
          <div className="relative p-5 rounded-2xl border border-genz-teal/30 overflow-hidden"
               style={{ background: 'linear-gradient(135deg, rgba(0,175,193,0.12), rgba(0,16,48,0.8))' }}>
            {/* Decorative glow */}
            <div className="absolute top-0 right-0 w-40 h-40 rounded-full pointer-events-none"
                 style={{ background: 'radial-gradient(circle, rgba(0,175,193,0.2) 0%, transparent 70%)', filter: 'blur(20px)' }} />
            <button onClick={() => setShowExtensionBanner(false)}
                    className="absolute top-3 right-3 text-genz-muted hover:text-white transition-colors z-10">
              <X size={16} />
            </button>
            <div className="flex items-start gap-4 relative z-10">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                   style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                <Chrome size={24} className="text-genz-deep-navy" />
              </div>
              <div className="flex-1">
                <h3 className="font-bold text-white mb-1">
                {bridgeReady
                  ? extConnStatus?.connected
                    ? `Extension Connected${extConnStatus?.version ? ` (v${extConnStatus.version})` : ''}`
                    : 'Extension Installed — Auto Connecting'
                  : extStatus === null
                    ? 'Checking Extension…'
                    : 'Install the Gen Z Digital Store Chrome Extension'
                }
              </h3>
                <p className="text-sm text-genz-muted mb-3">
                  Tools open only from this dashboard. The extension connects automatically using your logged-in client session and then applies admin-provided session cookies securely in the browser tab.
                </p>
                <div className="flex flex-wrap gap-3">
                  {!bridgeReady && extStatus !== null && (
                    <Link to="/chrome-extension"
                       className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-genz-deep-navy transition-all hover:opacity-90 hover:scale-105"
                       style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                      <Download size={15} />
                      Install Extension
                    </Link>
                  )}
                  {!bridgeReady && extStatus === null && (
                    <span className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-genz-teal/30 text-genz-teal">
                      <Loader2 size={15} className="animate-spin" /> Detecting extension…
                    </span>
                  )}
                  {bridgeReady && !extConnStatus?.connected && (
                    <span className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-genz-teal/30 text-genz-teal">
                      <Loader2 size={15} className="animate-spin" /> Auto connecting…
                    </span>
                  )}
                  {bridgeReady && extConnStatus?.connected && (
                    <span className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-green-500/30 text-green-300">
                      <CheckCircle2 size={15} /> Ready
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Featured Tools ── */}
        {featuredTools.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Star size={16} className="text-yellow-400" />
                <h2 className="font-bold text-white">Featured Tools</h2>
              </div>
              <button onClick={() => setActiveFilter('All')} className="text-xs text-genz-teal hover:underline">
                View All
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {featuredTools.map(tool => <ToolCard key={tool._id || tool.toolId} tool={tool} onOpen={handleOpenTool} openState={toolOpenStates[tool._id || tool.toolId]} />)}
            </div>
          </div>
        )}

        {/* ── All Tools with Search/Filter ── */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-white flex items-center gap-2">
              <Package size={16} className="text-genz-teal" />
              All Your Tools
            </h2>
          </div>

          {/* Search + Filter */}
          <div className="flex flex-col sm:flex-row gap-3 mb-5">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" />
              <input
                type="text"
                placeholder="Search tools..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm text-white placeholder-genz-muted focus:outline-none transition-all"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,175,193,0.15)' }}
              />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {categories.slice(0, 8).map(cat => (
                <button key={cat}
                        onClick={() => setActiveFilter(cat)}
                        className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                          activeFilter === cat
                            ? 'text-genz-deep-navy'
                            : 'border border-genz-border/30 text-genz-muted hover:border-genz-teal/30 hover:text-genz-teal'
                        }`}
                        style={activeFilter === cat
                          ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }
                          : {}}>
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Tool Grid */}
          {filteredTools.length === 0 ? (
            <div className="text-center py-16">
              <Package size={40} className="text-genz-muted mx-auto mb-3 opacity-40" />
              <p className="text-genz-muted">
                {searchQuery || activeFilter !== 'All'
                  ? 'No tools match your search'
                  : 'No tools assigned yet. Contact admin.'}
              </p>
              {(searchQuery || activeFilter !== 'All') && (
                <button onClick={() => { setSearchQuery(''); setActiveFilter('All'); }}
                        className="mt-3 text-sm text-genz-teal hover:underline">
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredTools.map(tool => (
                <ToolCard key={tool._id || tool.toolId} tool={tool} onOpen={handleOpenTool} openState={toolOpenStates[tool._id || tool.toolId]} />
              ))}
            </div>
          )}
        </div>


        {/* Scanner consent prompt — shown only when bridge ready and consent not yet given */}
        {bridgeReady && scanConsent === false && (
          <div className="flex items-start gap-3 p-4 rounded-2xl border border-genz-border/30 bg-white/[0.03]">
            <ShieldCheck size={18} className="text-genz-teal flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-white text-sm font-semibold mb-1">Optional Security Scanner</p>
              <p className="text-genz-muted text-xs leading-relaxed mb-3">
                Allow Gen Z Digital Store to check installed browser extensions for session-access
                risks. Only extension names and permissions are shared — no cookies, browsing history,
                or personal data. You can opt out any time from the extension popup.
              </p>
              <div className="flex gap-3">
                <button onClick={() => grantScanConsent().then(() => setScanConsent(true)).catch(() => {})}
                        className="px-4 py-1.5 rounded-lg text-xs font-semibold text-genz-deep-navy"
                        style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}>
                  Enable Scanner
                </button>
                <button onClick={() => setScanConsent(true)}
                        className="px-4 py-1.5 rounded-lg text-xs text-genz-muted hover:text-white transition-colors">
                  Not now
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Quick Help ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { icon: Chrome,  title: 'Extension Setup',  desc: 'Install our Chrome extension for one-click access', to: '/chrome-extension', cta: 'Install'  },
            { icon: Shield,  title: 'Account Security', desc: 'Manage your device binding and security settings',  to: '/client/profile', cta: 'Manage'   },
            { icon: Zap,     title: 'Need More Tools?', desc: 'Upgrade your membership to access all 90+ tools',   to: '/pricing',        cta: 'Upgrade'  },
          ].map(({ icon: Icon, title, desc, to, cta }) => (
            <Link key={title} to={to}
                  className={`${CARD_VARIANTS.default} p-5 rounded-2xl flex items-start gap-3 hover:border-genz-teal/30 transition-all group`}>
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                   style={{ background: 'rgba(0,175,193,0.12)' }}>
                <Icon size={16} className="text-genz-teal" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold text-white group-hover:text-genz-teal transition-colors">{title}</h4>
                <p className="text-xs text-genz-muted mt-0.5 leading-relaxed">{desc}</p>
                <span className="inline-flex items-center gap-1 mt-2 text-xs text-genz-teal font-medium">
                  {cta} <ArrowRight size={11} />
                </span>
              </div>
            </Link>
          ))}
        </div>

      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientDashboardEnhanced;
