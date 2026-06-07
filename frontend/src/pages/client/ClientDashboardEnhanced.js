import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ClientLayoutEnhanced, { getCategoryTheme, CARD_VARIANTS } from '../../components/ClientLayoutEnhanced';
import {
  Package, Clock, CheckCircle2, X, ExternalLink,
  Lock, Chrome, Download, Zap, Shield, User, Star, Search,
  AlertTriangle, Sparkles, ArrowRight, RefreshCw, Loader2, AlertCircle, ShieldCheck,
  MessageCircle
} from 'lucide-react';

const WHATSAPP_URL = 'https://wa.me/923027467462';
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

  const getBadges = () => {
    const badges = [];
    if (tool.isFeatured) badges.push({ label: 'Featured', color: 'bg-amber-100 text-amber-700' });
    if (tool.isNew)      badges.push({ label: 'New',      color: 'bg-green-100 text-green-700' });
    if (tool.isPopular)  badges.push({ label: 'Popular',  color: 'bg-purple-100 text-purple-700' });
    if (tool.isAI)       badges.push({ label: 'AI',       color: 'bg-blue-100 text-blue-700' });
    return badges;
  };

  return (
    <div className={`relative group rounded-2xl p-5 flex flex-col transition-all duration-200 hover:-translate-y-1 ${
      isExpired
        ? 'opacity-70 border border-red-200 bg-red-50'
        : 'gz-card'
    }`}>
      {/* Status indicator */}
      {isExpiring && (
        <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      )}

      {/* Tool header */}
      <div className="flex items-start justify-between mb-3">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-white font-black text-base bg-gradient-to-br ${theme.gradient}`}>
          {tool.name?.charAt(0) || '?'}
        </div>
        <div className="flex flex-wrap gap-1 justify-end">
          {getBadges().slice(0, 2).map(b => (
            <span key={b.label} className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${b.color}`}>
              {b.label}
            </span>
          ))}
        </div>
      </div>

      {/* Tool info */}
      <h3 className="font-bold text-genz-navy text-[15px] mb-0.5 truncate group-hover:text-genz-blue transition-colors">
        {tool.name}
      </h3>
      <p className={`text-[12px] font-semibold mb-2 ${theme.text}`}>{tool.category}</p>
      {tool.shortDescription && (
        <p className="text-[12.5px] text-genz-muted leading-relaxed mb-3 line-clamp-2">{tool.shortDescription}</p>
      )}

      {/* Status / expiry */}
      {isExpiring && (
        <div className="flex items-center gap-1 text-[12px] text-amber-600 mb-3">
          <AlertTriangle size={11} />
          <span>Expires in {tool.daysUntilExpiry}d</span>
        </div>
      )}
      {isExpired && (
        <div className="flex items-center gap-1 text-[12px] text-red-500 mb-3">
          <Lock size={11} />
          <span>Subscription expired</span>
        </div>
      )}

      {/* Actions */}
      <div className="mt-auto pt-2 space-y-2">
        <div className="flex gap-2">
          {!isExpired ? (
            <button
              onClick={() => onOpen && onOpen(tool)}
              disabled={openState?.loading}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[13px] font-bold text-white transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0"
              style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 8px 18px rgba(37,99,235,0.22)' }}>
              {openState?.loading
                ? <Loader2 size={13} className="animate-spin" />
                : <ExternalLink size={13} />
              }
              {openState?.loading ? 'Preparing…' : 'Access'}
            </button>
          ) : (
            <Link to="/contact"
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[13px] font-semibold border border-genz-blue/30 text-genz-blue hover:bg-genz-blue/[0.06] transition-all">
              <RefreshCw size={13} />
              Renew
            </Link>
          )}
          <Link to={`/client/tools/${tool._id}`}
                className="px-3 py-2.5 rounded-xl text-[13px] font-medium border border-genz-border text-genz-muted hover:border-genz-blue/40 hover:text-genz-blue transition-all">
            Info
          </Link>
        </div>
        {openState?.error && (
          <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-lg bg-red-50 border border-red-200">
            <AlertCircle size={12} className="text-red-500 flex-shrink-0 mt-0.5" />
            <span className="text-[12px] text-red-600 leading-snug">{openState.error}</span>
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

  /* ─── sanitizeError — maps raw extension/backend errors to user-safe messages ─ */
  const sanitizeError = (result) => {
    const raw = result?.actionableError || result?.message || result?.error || '';
    // Assignment-level errors — show "Contact admin", not internal details.
    if (result?.error === 'tool_access_expired' || /access expired|assignment.*expired|Tool access expired|revoked/i.test(raw)) {
      return 'Access expired. Contact admin.';
    }
    if (/not assigned|no assignment/i.test(raw)) {
      return 'Tool not assigned. Contact admin.';
    }
    // Never surface popup references to the user.
    if (/popup|reconnect from/i.test(raw)) {
      return 'Could not open tool. Please refresh the dashboard and try again.';
    }
    // Extension not installed/detected.
    if (result?.error === 'extension_not_detected') {
      return 'Extension not detected. Reload the extension, then refresh this page.';
    }
    // Suppress duplicate-open noise.
    if (result?.error === 'already_opening') return null;
    // Extension reloaded/updated mid-session → context invalidated.
    if (/context invalidated|Extension context/i.test(raw)) {
      return 'Extension was reloaded. Refresh this page, then click Access again.';
    }
    // Extension did not respond in time (service worker sleeping).
    if (/did not respond in time|timeout/i.test(raw)) {
      return 'Extension is waking up. Please wait 5 seconds and try again.';
    }
    return raw || 'Could not open tool.';
  };

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
    let result;
    try {
      result = await openTool(toolId);
    } catch (err) {
      // openTool should never throw (it returns {success:false}), but guard anyway.
      result = { success: false, error: err.message || 'unknown_error' };
    }
    if (result?.success) {
      setToolOpenStates(prev => ({ ...prev, [toolId]: {} }));
    } else {
      const msg = sanitizeError(result);
      if (msg) {
        setToolOpenStates(prev => ({ ...prev, [toolId]: { error: msg } }));
        // Auto-clear error after 8s
        setTimeout(() => setToolOpenStates(prev => {
          const copy = { ...prev };
          delete copy[toolId];
          return copy;
        }), 8000);
      } else {
        setToolOpenStates(prev => ({ ...prev, [toolId]: {} }));
      }
    }
  };

  /* ─── Loading State — skeleton screens ─ */
  if (loading) {
    return (
      <ClientLayoutEnhanced>
        <div className="space-y-6 animate-pulse">
          {/* Header skeleton */}
          <div className="space-y-2">
            <div className="h-3 w-28 rounded bg-genz-border" />
            <div className="h-8 w-64 rounded-lg bg-genz-border" />
            <div className="h-3 w-40 rounded bg-genz-border/60" />
          </div>
          {/* Stats skeleton */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="p-5 rounded-2xl bg-white border border-genz-border">
                <div className="h-9 w-9 rounded-xl bg-genz-border mb-3" />
                <div className="h-6 w-12 rounded bg-genz-border mb-2" />
                <div className="h-3 w-16 rounded bg-genz-border/60" />
              </div>
            ))}
          </div>
          {/* Tool grid skeleton */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="p-5 rounded-2xl bg-white border border-genz-border">
                <div className="h-11 w-11 rounded-xl bg-genz-border mb-3" />
                <div className="h-4 w-3/4 rounded bg-genz-border mb-2" />
                <div className="h-3 w-1/3 rounded bg-genz-border/60 mb-3" />
                <div className="h-9 w-full rounded-xl bg-genz-border/60" />
              </div>
            ))}
          </div>
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
          <div className="flex items-start gap-3 p-4 rounded-2xl border border-amber-200 bg-amber-50">
            <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-amber-700 font-semibold text-sm mb-1">
                {expiringTools.length} tool{expiringTools.length > 1 ? 's' : ''} expiring soon
              </p>
              <p className="text-amber-600/80 text-xs">
                {expiringTools.slice(0, 3).map(t => t.toolName).join(', ')}
                {expiringTools.length > 3 && ` +${expiringTools.length - 3} more`}
              </p>
            </div>
            <button onClick={dismissExpiryWarning} className="text-amber-500/70 hover:text-amber-700 transition-colors">
              <X size={16} />
            </button>
          </div>
        )}

        {/* ── Welcome / Membership Banner ── */}
        <div className="gz-panel-dark relative overflow-hidden p-6 sm:p-7">
          <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(40rem 20rem at 100% 0%, rgba(6,182,212,0.22), transparent 60%)' }} />
          <div className="relative flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <Sparkles size={15} className="text-genz-cyan" />
                <span className="text-genz-cyan text-[13px] font-semibold uppercase tracking-wider">Welcome back</span>
              </div>
              <h1 className="font-heading text-[28px] sm:text-[32px] font-extrabold text-white leading-tight">
                {user?.fullName ? user.fullName.split(' ')[0] : 'Member'}'s Dashboard
              </h1>
              <p className="text-white/65 text-sm mt-1.5">
                You have access to <span className="text-white font-bold">{activeTools.length}</span> premium tools.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
                <p className="text-[11px] text-white/55 uppercase tracking-wider">Membership</p>
                <p className="text-sm font-bold mt-0.5">
                  {user?.expiryDate
                    ? (new Date(user.expiryDate) > new Date()
                        ? <span className="text-emerald-300">Active · until {new Date(user.expiryDate).toLocaleDateString()}</span>
                        : <span className="text-red-300">Expired</span>)
                    : <span className="text-emerald-300">Active</span>}
                </p>
              </div>
              <Link to="/client/profile"
                    className="w-11 h-11 rounded-xl flex items-center justify-center text-white transition-all hover:-translate-y-0.5"
                    style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.14)' }}
                    title="My Profile">
                <User size={18} />
              </Link>
            </div>
          </div>
        </div>

        {/* ── Stats Row ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {(() => {
            const accountActive = !user?.expiryDate || new Date(user.expiryDate) > new Date();
            const cards = [
              { icon: CheckCircle2, kind: 'num',    value: activeTools.length,   label: 'Active Tools',    sub: 'Ready to use',      color: '#16A34A' },
              { icon: Clock,        kind: 'num',    value: expiringTools.length, label: 'Expiring Soon',   sub: 'Within 7 days',     color: '#D97706' },
              { icon: ShieldCheck,  kind: 'status', value: accountActive ? 'Active' : 'Expired', badge: accountActive ? 'ds-badge-success' : 'ds-badge-danger', label: 'Account Status', sub: 'Membership', color: accountActive ? '#16A34A' : '#EF4444' },
              { icon: Shield,       kind: 'status', value: 'Secured', badge: 'ds-badge-teal', label: 'Device Security', sub: 'Encrypted bridge', color: '#06B6D4' },
            ];
            return cards.map(({ icon: Icon, kind, value, label, sub, color, badge }) => (
              <div key={label} className="ds-card ds-stat relative overflow-hidden p-5">
                <div className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${color}, ${color}55)` }} />
                <div className="flex items-center justify-between mb-3.5">
                  <span className="w-11 h-11 rounded-xl flex items-center justify-center"
                        style={{ background: `${color}14`, color, border: `1px solid ${color}26` }}>
                    <Icon size={19} />
                  </span>
                </div>
                {kind === 'num'
                  ? <div className="font-heading text-[30px] font-extrabold text-genz-navy tabular-nums leading-none">{value}</div>
                  : <div className="mt-0.5"><span className={`ds-badge ${badge}`}><span className="dot" /> {value}</span></div>}
                <div className="text-[13.5px] font-semibold text-genz-navy mt-2">{label}</div>
                <div className="text-[12px] text-genz-muted mt-0.5">{sub}</div>
              </div>
            ));
          })()}
        </div>

        {/* ── Chrome Extension Banner ── hide after connected and dismissed */}
        {showExtensionBanner && !(bridgeReady && extConnStatus?.connected) && (
          <div className="relative p-5 rounded-2xl border overflow-hidden"
               style={{ background: 'linear-gradient(135deg, rgba(37,99,235,0.07), rgba(6,182,212,0.07))', borderColor: 'rgba(6,182,212,0.25)' }}>
            <button onClick={() => setShowExtensionBanner(false)}
                    className="absolute top-3 right-3 text-genz-muted hover:text-genz-navy transition-colors z-10">
              <X size={16} />
            </button>
            <div className="flex items-start gap-4 relative z-10">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                   style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)' }}>
                <Chrome size={24} className="text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-bold text-genz-navy mb-1">
                {bridgeReady
                  ? extConnStatus?.connected
                    ? `Extension Connected${extConnStatus?.version ? ` (v${extConnStatus.version})` : ''}`
                    : 'Extension Installed — Auto Connecting'
                  : extConnStatus?.checking
                    ? 'Checking Extension…'
                    : 'Install the Gen Z Digital Store Chrome Extension'
                }
              </h3>
                <p className="text-sm text-genz-muted mb-3">
                  Tools open only from this dashboard. The extension connects automatically using your logged-in client session and then applies admin-provided session cookies securely in the browser tab.
                </p>
                <div className="flex flex-wrap gap-3">
                  {!bridgeReady && !extConnStatus?.checking && (
                    <Link to="/chrome-extension"
                       className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-white transition-all hover:-translate-y-0.5"
                       style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)' }}>
                      <Download size={15} />
                      Install Extension
                    </Link>
                  )}
                  {!bridgeReady && extConnStatus?.checking && (
                    <span className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-genz-blue/30 text-genz-blue">
                      <Loader2 size={15} className="animate-spin" /> Detecting extension…
                    </span>
                  )}
                  {bridgeReady && !extConnStatus?.connected && (
                    <span className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-genz-blue/30 text-genz-blue">
                      <Loader2 size={15} className="animate-spin" /> Auto connecting…
                    </span>
                  )}
                  {bridgeReady && extConnStatus?.connected && (
                    <span className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-green-200 text-green-600 bg-green-50">
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
                <Star size={16} className="text-amber-500" />
                <h2 className="font-bold text-genz-navy text-[18px]">Featured Tools</h2>
              </div>
              <button onClick={() => setActiveFilter('All')} className="text-[13px] font-semibold text-genz-blue hover:underline">
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
            <h2 className="font-bold text-genz-navy text-[18px] flex items-center gap-2">
              <Package size={17} className="text-genz-blue" />
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
                aria-label="Search tools"
                className="w-full rounded-[14px] border border-genz-border bg-white pl-9 pr-4 py-2.5 text-sm text-genz-navy placeholder:text-genz-muted/70 outline-none transition-all focus:border-genz-blue focus:ring-4 focus:ring-genz-blue/12"
              />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {categories.slice(0, 8).map(cat => (
                <button key={cat}
                        onClick={() => setActiveFilter(cat)}
                        className={`flex-shrink-0 px-3.5 py-2 rounded-xl text-[13px] font-semibold transition-all ${
                          activeFilter === cat
                            ? 'text-white'
                            : 'border border-genz-border text-genz-muted hover:border-genz-blue/40 hover:text-genz-blue'
                        }`}
                        style={activeFilter === cat
                          ? { background: 'linear-gradient(135deg, #2563EB, #06B6D4)' }
                          : {}}>
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Tool Grid */}
          {filteredTools.length === 0 ? (
            <div className="gz-card text-center py-16 px-6">
              <div className="w-14 h-14 rounded-2xl bg-genz-bg flex items-center justify-center mx-auto mb-4">
                <Package size={26} className="text-genz-muted" />
              </div>
              <p className="text-genz-navy font-semibold">
                {searchQuery || activeFilter !== 'All'
                  ? 'No tools match your search'
                  : 'No tools assigned yet'}
              </p>
              <p className="text-genz-muted text-sm mt-1">
                {searchQuery || activeFilter !== 'All'
                  ? 'Try a different keyword or filter.'
                  : 'Contact your admin to get tools assigned to your account.'}
              </p>
              {(searchQuery || activeFilter !== 'All') && (
                <button onClick={() => { setSearchQuery(''); setActiveFilter('All'); }}
                        className="mt-4 text-sm font-semibold text-genz-blue hover:underline">
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
          <div className="flex items-start gap-3 p-4 rounded-2xl border border-genz-border bg-white">
            <ShieldCheck size={18} className="text-genz-blue flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-genz-navy text-sm font-semibold mb-1">Optional Security Scanner</p>
              <p className="text-genz-muted text-xs leading-relaxed mb-3">
                Allow Gen Z Digital Store to check installed browser extensions for session-access
                risks. Only extension names and permissions are shared — no cookies, browsing history,
                or personal data. You can opt out any time from the extension popup.
              </p>
              <div className="flex gap-3">
                <button onClick={() => grantScanConsent().then(() => setScanConsent(true)).catch(() => {})}
                        className="px-4 py-2 rounded-lg text-xs font-bold text-white"
                        style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
                  Enable Scanner
                </button>
                <button onClick={() => setScanConsent(true)}
                        className="px-4 py-2 rounded-lg text-xs font-semibold text-genz-muted hover:text-genz-navy transition-colors">
                  Not now
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── WhatsApp Support banner ── */}
        <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer"
           className="ds-card ds-stat group relative overflow-hidden flex items-center gap-4 p-5">
          <div className="absolute inset-x-0 top-0 h-1" style={{ background: 'linear-gradient(90deg,#22c55e,#06B6D4)' }} />
          <span className="w-12 h-12 rounded-xl flex items-center justify-center text-white flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#22c55e,#16a34a)', boxShadow: '0 8px 18px -8px rgba(34,197,94,0.6)' }}>
            <MessageCircle size={22} />
          </span>
          <div className="flex-1 min-w-0">
            <h4 className="text-[15px] font-bold text-genz-navy flex items-center gap-2">
              WhatsApp Support <span className="ds-badge ds-badge-success"><span className="dot" /> Online</span>
            </h4>
            <p className="text-[13px] text-genz-muted mt-0.5">Chat with our team for help, tool requests, or a new order — fast replies.</p>
          </div>
          <span className="hidden sm:inline-flex items-center gap-1.5 px-4 py-2.5 rounded-[12px] text-[14px] font-bold text-white"
                style={{ background: 'linear-gradient(135deg,#22c55e,#16a34a)' }}>
            Chat now <ArrowRight size={15} />
          </span>
        </a>

        {/* ── Quick actions ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { icon: Chrome, title: 'Extension Setup',  desc: 'Install the Chrome extension for one-click tool access.', to: '/chrome-extension', cta: 'Install', grad: 'linear-gradient(135deg,#2563EB,#06B6D4)' },
            { icon: Shield, title: 'Account Security', desc: 'Manage device binding and your security settings.',        to: '/client/profile',   cta: 'Manage',  grad: 'linear-gradient(135deg,#0891B2,#14B8A6)' },
            { icon: Zap,    title: 'Need More Tools?', desc: 'Upgrade your membership to unlock all 90+ tools.',         to: '/pricing',          cta: 'Upgrade', grad: 'linear-gradient(135deg,#4F46E5,#2563EB)' },
          ].map(({ icon: Icon, title, desc, to, cta, grad }) => (
            <Link key={title} to={to} className="ds-card ds-stat p-5 flex flex-col group">
              <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white mb-3.5" style={{ background: grad, boxShadow: '0 8px 16px -8px rgba(37,99,235,0.5)' }}>
                <Icon size={19} />
              </span>
              <h4 className="text-[15px] font-bold text-genz-navy group-hover:text-genz-blue transition-colors">{title}</h4>
              <p className="text-[13px] text-genz-muted mt-1 leading-relaxed flex-1">{desc}</p>
              <span className="inline-flex items-center gap-1.5 mt-3 text-[13px] text-genz-blue font-semibold group-hover:gap-2.5 transition-all">
                {cta} <ArrowRight size={13} />
              </span>
            </Link>
          ))}
        </div>

      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientDashboardEnhanced;
