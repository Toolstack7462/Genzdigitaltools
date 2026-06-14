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
              data-testid="access-tool-btn"
              data-genz-action="open-tool"
              data-tool-id={tool._id || tool.toolId}
              data-tool-url={tool.targetUrl || tool.loginUrl || ''}
              data-action-type={tool.credentialType === 'cookies' || tool.credentialType === 'token' ? 'processTool' : 'openToolDirect'}
              onClick={() => onOpen && onOpen(tool)}
              disabled={openState?.loading}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[13px] font-bold text-white transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0"
              style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 8px 18px rgba(37,99,235,0.22)' }}>
              {openState?.loading
                ? <Loader2 size={13} className="animate-spin" />
                : <ExternalLink size={13} />
              }
              {openState?.loading ? 'Opening Tool' : 'Access'}
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
  // Readiness model: if the extension bridge is present it is treated as READY.
  // The secure session is fetched on-demand when Access is clicked, so there is
  // no manual connect/reconnect step and no "connecting/disconnected" limbo.
  const { status: extConnStatus, bridgeReady, openTool, grantScanConsent, getScanStatus } = useExtension();
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
    // Missing session bundle is NOT an expiry — show it distinctly (req #7).
    if (result?.error === 'session_bundle_missing' || /session missing|session for this tool is not available/i.test(raw)) {
      return 'Session missing. Contact admin.';
    }
    // Tool not assigned is NOT an expiry — show it distinctly (req #8).
    if (result?.error === 'assignment_not_found' || /not assigned|no assignment/i.test(raw)) {
      return 'Tool not assigned. Contact admin.';
    }
    // Assigned, but no usable authorized session could be applied (OceanHub req #10).
    if (result?.error === 'no_active_session' || /no active session/i.test(raw)) {
      return 'No active session assigned for this tool. Please refresh or assign account from admin.';
    }
    // Genuine expiry/revoke only.
    if (result?.error === 'tool_access_expired' || result?.error === 'assignment_expired'
        || /access expired|assignment has expired|Tool access expired|revoked/i.test(raw)) {
      return 'Access expired. Contact admin.';
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
        [toolId]: { error: 'Install Extension' }
      }));
      return;
    }

    // openTool() wakes the extension and ensures a live session on its own —
    // no separate connect step needed here.
    setToolOpenStates(prev => ({ ...prev, [toolId]: { loading: true } }));
    let result;
    try {
      // OceanHub req #1: send a proper tool request (toolId + requested tool URL
      // + assigned session id). The extension supplies its own session token.
      result = await openTool(toolId, {
        requestedToolUrl: tool.targetUrl || tool.target_url || tool.url || null,
        assignmentId: tool.assignmentId || null,
        loginType: tool.credentialType || null,
        domain: tool.domain || null,
      });
    } catch (err) {
      // openTool should never throw (it returns {success:false}), but guard anyway.
      result = { success: false, error: err.message || 'unknown_error' };
    }
    const clearState = () => setToolOpenStates(prev => {
      const copy = { ...prev }; delete copy[toolId]; return copy;
    });
    const showToolError = (msg) => {
      if (!msg) { clearState(); return; }
      setToolOpenStates(prev => ({ ...prev, [toolId]: { error: msg } }));
      setTimeout(clearState, 8000);
    };

    if (result?.success) {
      clearState();
      return;
    }

    // ── #9 guarantee: never show "expired"/"not assigned" for a tool the
    // dashboard's OWN (shared-helper) list still returns. Re-verify against a
    // FRESH list; if the tool is still visible it's a transient mismatch, not an
    // expiry — retry the open once, then show a soft retry message. Only if the
    // tool is ALSO gone from the fresh list do we surface expired/not-assigned.
    const ACCESS_DENY = ['tool_access_expired', 'assignment_expired', 'assignment_not_found'];
    if (ACCESS_DENY.includes(result?.error)) {
      let stillVisible = false;
      try {
        const fresh = await api.get('/client/tools');
        const freshTools = fresh.data.tools || [];
        setTools(freshTools);
        stillVisible = freshTools.some(t => String(t._id || t.toolId) === String(toolId));
      } catch (_) { /* keep stillVisible=false → fall through to precise message */ }

      if (stillVisible) {
        const retry = await openTool(toolId).catch(() => ({ success: false }));
        if (retry?.success) { clearState(); return; }
        showToolError('Could not open this tool right now. Please try again in a moment.');
        return;
      }
      // Tool genuinely removed from the dashboard list → message is now consistent.
    }

    showToolError(sanitizeError(result));
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
      <div className="space-y-3">

        {/* ── Expiry Warning Banner (slim, dark-glass amber) ── */}
        {showExpiryWarning && expiringTools.length > 0 && (
          <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-xl"
               style={{
                 background: 'linear-gradient(120deg, rgba(120,53,15,0.32), rgba(120,53,15,0.18))',
                 border: '1px solid rgba(251,191,36,0.30)',
                 boxShadow: '0 6px 18px -12px rgba(245,158,11,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
               }}>
            <AlertTriangle size={13} className="text-amber-300 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-amber-200 font-semibold text-[12px]">
                {expiringTools.length} tool{expiringTools.length > 1 ? 's' : ''} expiring soon
              </span>
              <span className="text-amber-200/70 text-[11px] ml-2 truncate">
                · {expiringTools.slice(0, 3).map(t => t.toolName).join(', ')}
                {expiringTools.length > 3 && ` +${expiringTools.length - 3}`}
              </span>
            </div>
            <button onClick={dismissExpiryWarning} className="text-amber-200/60 hover:text-amber-100 transition-colors">
              <X size={13} />
            </button>
          </div>
        )}

        {/* ── Welcome / Membership Banner — slim strip, glass + gradient ── */}
        <div
          className="relative overflow-hidden rounded-2xl px-4 sm:px-5 py-3 sm:py-3.5"
          style={{
            background:
              'linear-gradient(120deg, rgba(7,27,51,0.95) 0%, rgba(15,42,73,0.95) 55%, rgba(6,78,89,0.92) 100%)',
            border: '1px solid rgba(6,182,212,0.18)',
            boxShadow:
              '0 10px 30px -18px rgba(6,182,212,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
          }}
        >
          {/* glow accents */}
          <div
            className="absolute -top-16 -right-10 w-72 h-40 pointer-events-none opacity-70"
            style={{ background: 'radial-gradient(closest-side, rgba(6,182,212,0.28), transparent 70%)' }}
          />
          <div
            className="absolute -bottom-20 left-1/3 w-72 h-40 pointer-events-none opacity-50"
            style={{ background: 'radial-gradient(closest-side, rgba(37,99,235,0.22), transparent 70%)' }}
          />
          <div className="relative flex items-center justify-between gap-3 flex-wrap">
            {/* Left: greeting (inline single row) */}
            <div className="flex items-center gap-3 min-w-0">
              <span
                className="hidden sm:flex w-9 h-9 rounded-xl items-center justify-center flex-shrink-0"
                style={{
                  background: 'linear-gradient(135deg, #2563EB, #06B6D4)',
                  boxShadow: '0 6px 18px -6px rgba(6,182,212,0.6)',
                }}
              >
                <Sparkles size={15} className="text-white" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 leading-none">
                  <span className="text-genz-cyan text-[10px] font-bold uppercase tracking-[0.14em]">
                    Welcome back
                  </span>
                  <span className="hidden sm:inline text-white/25 text-[10px]">•</span>
                  <span className="hidden sm:inline text-white/60 text-[11px] font-medium">
                    {new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                </div>
                <h1 className="font-heading text-[17px] sm:text-[19px] font-extrabold text-white leading-tight mt-1 truncate">
                  {user?.fullName ? user.fullName.split(' ')[0] : 'Member'}'s Dashboard
                  <span className="ml-2 inline-flex items-center gap-1 align-middle px-2 py-[3px] rounded-md text-[10.5px] font-bold text-genz-cyan"
                        style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.28)' }}>
                    <Package size={10} /> {activeTools.length} tools
                  </span>
                </h1>
              </div>
            </div>

            {/* Right: membership + actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <div
                className="hidden sm:flex items-center gap-2 h-9 px-3 rounded-lg backdrop-blur-md"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)' }}
              >
                <span className="text-[9.5px] text-white/50 uppercase tracking-wider font-semibold">Plan</span>
                <span className="text-[11.5px] font-bold">
                  {user?.expiryDate
                    ? (new Date(user.expiryDate) > new Date()
                        ? <span className="text-emerald-300">Active · {new Date(user.expiryDate).toLocaleDateString()}</span>
                        : <span className="text-red-300">Expired</span>)
                    : <span className="text-emerald-300">Active</span>}
                </span>
              </div>
              <a
                href="https://genzdigitalstore.com"
                target="_blank"
                rel="noopener noreferrer"
                className="hidden md:inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-white text-[11.5px] font-semibold transition-all hover:-translate-y-0.5 hover:bg-white/[0.12]"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}
                title="View Website"
              >
                <ExternalLink size={13} /> Website
              </a>
              <Link
                to="/client/profile"
                className="w-9 h-9 rounded-lg flex items-center justify-center text-white transition-all hover:-translate-y-0.5 hover:bg-white/[0.12]"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}
                title="My Profile"
              >
                <User size={14} />
              </Link>
            </div>
          </div>
        </div>

        {/* ── Stats Row — horizontal premium glass cards ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3">
          {(() => {
            const accountActive = !user?.expiryDate || new Date(user.expiryDate) > new Date();
            const cards = [
              { icon: CheckCircle2, kind: 'num',    value: activeTools.length,   label: 'Active Tools',    sub: 'Ready to use',      color: '#16A34A' },
              { icon: Clock,        kind: 'num',    value: expiringTools.length, label: 'Expiring Soon',   sub: 'Within 7 days',     color: '#D97706' },
              { icon: ShieldCheck,  kind: 'status', value: accountActive ? 'Active' : 'Expired', badge: accountActive ? 'ds-badge-success' : 'ds-badge-danger', label: 'Account Status', sub: 'Membership',        color: accountActive ? '#16A34A' : '#EF4444' },
              { icon: Shield,       kind: 'status', value: 'Secured', badge: 'ds-badge-teal',     label: 'Device Security', sub: 'Encrypted bridge',  color: '#06B6D4' },
            ];
            return cards.map(({ icon: Icon, kind, value, label, sub, color, badge }) => (
              <div
                key={label}
                className="group relative overflow-hidden rounded-xl px-3.5 py-3 transition-all duration-300 hover:-translate-y-0.5"
                style={{
                  background: 'linear-gradient(165deg, rgba(255,255,255,0.99) 0%, rgba(244,250,253,0.96) 100%)',
                  border: `1px solid ${color}33`,
                  boxShadow: `0 1px 0 rgba(255,255,255,0.9) inset, 0 10px 24px -16px rgba(2,10,25,0.55), 0 4px 12px -10px ${color}55`,
                }}
              >
                {/* left color rail */}
                <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: `linear-gradient(180deg, ${color}, ${color}66)` }} />
                {/* soft top wash */}
                <div className="absolute inset-x-0 top-0 h-8 pointer-events-none" style={{ background: `linear-gradient(180deg, ${color}10, transparent)` }} />
                {/* hover glow */}
                <div
                  className="absolute -inset-px rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                  style={{ boxShadow: `0 14px 30px -14px ${color}66, 0 0 0 1px ${color}44 inset` }}
                />
                <div className="relative flex items-center gap-3 pl-1.5">
                  <span
                    className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-transform duration-300 group-hover:scale-105"
                    style={{
                      background: `linear-gradient(135deg, ${color}26, ${color}10)`,
                      color,
                      border: `1px solid ${color}40`,
                      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.55), 0 4px 10px -6px ${color}55`,
                    }}
                  >
                    <Icon size={15} strokeWidth={2.4} />
                  </span>
                  <div className="min-w-0 flex-1">
                    {kind === 'num' ? (
                      <div className="font-heading text-[22px] font-extrabold tabular-nums leading-none" style={{ color: '#071B33' }}>
                        {value}
                      </div>
                    ) : (
                      <span className={`ds-badge ${badge} !text-[10.5px] !py-[2px] !px-1.5`}><span className="dot" /> {value}</span>
                    )}
                    <div className="text-[11.5px] font-bold mt-1.5 truncate tracking-tight" style={{ color: '#071B33' }}>{label}</div>
                    <div className="text-[10.5px] leading-tight truncate mt-0.5" style={{ color: '#5B6B7C' }}>{sub}</div>
                  </div>
                </div>
              </div>
            ));
          })()}
        </div>

        {/* ── Chrome Extension Banner ── only while the extension is NOT yet
            detected. Once the bridge is present the extension is READY (the
            secure session is fetched on-demand when Access is clicked), so we
            never show a "connecting / disconnected / retry" state. */}
        {showExtensionBanner && !bridgeReady && (
          <div className="relative overflow-hidden rounded-2xl px-4 sm:px-5 py-3.5"
               style={{
                 background: 'linear-gradient(120deg, rgba(7,27,51,0.92) 0%, rgba(15,42,73,0.92) 60%, rgba(6,78,89,0.88) 100%)',
                 border: '1px solid rgba(6,182,212,0.22)',
                 boxShadow: '0 10px 26px -16px rgba(6,182,212,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
               }}>
            <div className="absolute -top-12 -right-8 w-56 h-32 pointer-events-none opacity-60"
                 style={{ background: 'radial-gradient(closest-side, rgba(6,182,212,0.32), transparent 70%)' }} />
            <button onClick={() => setShowExtensionBanner(false)}
                    className="absolute top-2.5 right-2.5 text-white/40 hover:text-white transition-colors z-10">
              <X size={14} />
            </button>
            <div className="flex items-center gap-3 relative z-10">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                   style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)', boxShadow: '0 6px 18px -8px rgba(6,182,212,0.7)' }}>
                <Chrome size={18} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-white text-[13.5px] leading-tight" data-testid="ext-banner-title">
                  {extConnStatus?.checking ? 'Checking Extension…' : 'Install the Chrome Extension'}
                </h3>
                <p className="text-[11.5px] text-white/60 mt-0.5 leading-snug">
                  One-click access to all your tools. Install once and you're set.
                </p>
              </div>
              <div className="flex-shrink-0">
                {!extConnStatus?.checking ? (
                  <Link to="/chrome-extension"
                     className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold text-white transition-all hover:-translate-y-0.5"
                     style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)', boxShadow: '0 6px 16px -8px rgba(37,99,235,0.65)' }}>
                    <Download size={13} /> Install
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold text-genz-cyan"
                        style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.28)' }}>
                    <Loader2 size={13} className="animate-spin" /> Detecting…
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Featured Tools ── */}
        {featuredTools.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Star size={15} className="text-amber-400" />
                <h2 className="font-bold text-white text-[15px] tracking-tight">Featured Tools</h2>
              </div>
              <button onClick={() => setActiveFilter('All')} className="text-[12px] font-semibold text-genz-cyan hover:text-white transition-colors">
                View All →
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {featuredTools.map(tool => <ToolCard key={tool._id || tool.toolId} tool={tool} onOpen={handleOpenTool} openState={toolOpenStates[tool._id || tool.toolId]} />)}
            </div>
          </div>
        )}

        {/* ── All Tools with Search/Filter ── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-white text-[15px] flex items-center gap-2 tracking-tight">
              <Package size={15} className="text-genz-cyan" />
              All Your Tools
              <span className="ml-1 text-[10.5px] font-bold text-genz-cyan px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.25)' }}>
                {tools.length}
              </span>
            </h2>
          </div>

          {/* Search + Filter */}
          <div className="flex flex-col sm:flex-row gap-2.5 mb-4">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                type="text"
                placeholder="Search tools..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                aria-label="Search tools"
                className="w-full rounded-xl pl-9 pr-4 py-2 text-[13px] text-white placeholder:text-white/35 outline-none transition-all"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  backdropFilter: 'blur(8px)',
                }}
              />
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {categories.slice(0, 8).map(cat => (
                <button key={cat}
                        onClick={() => setActiveFilter(cat)}
                        className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all ${
                          activeFilter === cat
                            ? 'text-white shadow-md'
                            : 'text-white/55 hover:text-white'
                        }`}
                        style={activeFilter === cat
                          ? { background: 'linear-gradient(135deg, #2563EB, #06B6D4)', boxShadow: '0 4px 14px -6px rgba(6,182,212,0.55)' }
                          : { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)' }}>
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
                Checks installed extensions for session-access risks. No cookies or personal data are shared.
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
