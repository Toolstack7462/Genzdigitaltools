import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
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
import { EXT_ZIP_URL, EXT_ZIP_FILENAME, extZipUrl, versionedZipName, getLatestExtension } from '../../lib/extension';
import { isOlder } from '../../lib/semver';
import { authService } from '../../services/authService';
import { useExtension } from '../../hooks/useExtension';
import StealthWriterCard from '../../components/StealthWriterCard';
import RenewPlanLink from '../../components/RenewPlanLink';
import { useStealthSummary } from '../../hooks/useStealthSummary';
import ProxyToolCard from '../../components/ProxyToolCard';
import { useProxyTools } from '../../hooks/useProxyTools';


/* ─── Snooze intervals — a dismissed notice re-appears after this long (the 45s
   notification poll brings it back automatically; no page refresh needed). ─── */
const EXT_MANDATORY_SNOOZE_MS = 5 * 60 * 1000;        // required update — re-nag every 5 min
const EXT_OPTIONAL_SNOOZE_MS  = 10 * 60 * 1000;       // optional update — re-show after 10 min
const ANNOUNCE_SNOOZE_MS      = 10 * 60 * 1000;       // announcement — re-show after 10 min

/* ─── Extension detection is handled by useExtension() bridge heartbeat.
   No Chrome extension ID is needed in the React build. */
/* ─── Tool Card Component ────────────────────────────────────────── */
/* memo: the dashboard re-renders frequently while the extension bridge polls
   its status (~every 500ms during detection). Memoizing keeps the tool grid
   from re-rendering on every status tick — it only re-renders when its own
   tool/openState props actually change. Pure render optimization; no behaviour
   change. */
const ToolCard = memo(({ tool, onOpen, openState }) => {
  const theme = getCategoryTheme(tool.category);
  const days = tool.daysUntilExpiry;
  const hasDays = typeof days === 'number' && days >= 0;
  const isExpired  = tool.status === 'expired';
  const isUrgent   = !isExpired && hasDays && days <= 3;   // 0–3 days → red/orange
  const isWarning  = !isExpired && hasDays && days >= 4 && days <= 7; // 4–7 → amber
  const isExpiring = isUrgent || isWarning;
  const fmtFull = (d) => { const dt = new Date(d); return isNaN(dt.getTime()) ? null : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
  const endDateStr = fmtFull(tool.endDate || tool.accessEndDate);
  const expiryLabel = (days === 0 ? 'Expires today' : `Expires in ${days}d`) + (endDateStr ? ` · ${endDateStr}` : '');
  const expiredLabel = 'Expired' + (endDateStr ? ` · ${endDateStr}` : '');

  const getBadges = () => {
    const badges = [];
    if (tool.isFeatured) badges.push({ label: 'Featured', color: 'bg-amber-100 text-amber-700' });
    if (tool.isNew)      badges.push({ label: 'New',      color: 'bg-green-100 text-green-700' });
    if (tool.isPopular)  badges.push({ label: 'Popular',  color: 'bg-purple-100 text-purple-700' });
    if (tool.isAI)       badges.push({ label: 'AI',       color: 'bg-blue-100 text-blue-700' });
    return badges;
  };

  return (
    <div className={`relative group rounded-xl p-4 flex flex-col transition-all duration-300 hover:-translate-y-1 ${
      isExpired
        ? 'opacity-80 border border-red-200 bg-red-50'
        : 'gz-card hover:shadow-[0_18px_38px_-18px_rgba(37,99,235,0.45),0_0_0_1px_rgba(6,182,212,0.18)]'
    }`}
      style={!isExpired ? { background: 'linear-gradient(167deg,#ffffff 0%,#f6fbfe 100%)' } : undefined}
    >
      {/* subtle hover sheen */}
      {!isExpired && (
        <div className="absolute inset-x-0 top-0 h-10 rounded-t-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
             style={{ background: 'linear-gradient(180deg, rgba(6,182,212,0.08), transparent)' }} />
      )}
      {/* Status indicator */}
      {isExpiring && (
        <div className={`absolute top-3 right-3 w-2 h-2 rounded-full animate-pulse ${isUrgent ? 'bg-red-500' : 'bg-amber-400'}`} />
      )}

      {/* Tool header */}
      <div className="flex items-start justify-between mb-2.5">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white font-black text-[15px] bg-gradient-to-br ${theme.gradient}`}>
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
        <div className="mb-3">
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold ${
            isUrgent ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
          }`}>
            <AlertTriangle size={11} /> {expiryLabel}
          </span>
        </div>
      )}
      {isExpired && (
        <div className="mb-3">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-700">
            <Lock size={11} /> {expiredLabel}
          </span>
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
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12.5px] font-bold text-white transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0"
              style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)', boxShadow: '0 8px 18px rgba(37,99,235,0.22)' }}>
              {openState?.loading
                ? <Loader2 size={13} className="animate-spin" />
                : <ExternalLink size={13} />
              }
              {openState?.loading ? 'Opening Tool' : 'Access'}
            </button>
          ) : (
            <RenewPlanLink
              toolName={tool.name}
              status="expired"
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12.5px] font-semibold border border-genz-blue/30 text-genz-blue hover:bg-genz-blue/[0.06] transition-all">
              <RefreshCw size={13} />
              Renew
            </RenewPlanLink>
          )}
          <Link to={`/client/tools/${tool._id}`}
                className="px-3 py-2 rounded-lg text-[12.5px] font-medium border border-genz-border text-genz-muted hover:border-genz-blue/40 hover:text-genz-blue transition-all">
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
});
ToolCard.displayName = 'ToolCard';

/* ─── MAIN DASHBOARD ─────────────────────────────────────────────── */
const ClientDashboardEnhanced = () => {
  const navigate = useNavigate();
  const { showError, showWarning, showInfo } = useToast();
  // The Install Extension button downloads the static ZIP directly. We don't
  // preventDefault (so the anchor's own download fires in the user gesture,
  // avoiding popup blockers); this just verifies the file is reachable and
  // surfaces a clear error if it's missing.
  const verifyExtensionDownload = useCallback(() => {
    fetch(EXT_ZIP_URL, { method: 'HEAD' })
      .then((r) => { if (!r.ok) throw new Error('missing'); })
      .catch(() => showError('Extension download is temporarily unavailable. Please try again or contact support.'));
  }, [showError]);
  const [tools, setTools] = useState([]);
  const [expiringTools, setExpiringTools] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showExpiryWarning, setShowExpiryWarning] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');

  const user = authService.getCurrentUser();
  // Readiness model: if the extension bridge is present it is treated as READY.
  // The secure session is fetched on-demand when Access is clicked, so there is
  // no manual connect/reconnect step and no "connecting/disconnected" limbo.
  const { status: extConnStatus, bridgeReady, openTool, grantScanConsent, getScanStatus } = useExtension();
  const { stealth, loading: stealthLoading } = useStealthSummary(); // StealthWriter plan summary (shown as a tool card)
  const { proxyTools } = useProxyTools(); // HIX AI / BypassGPT (shown as tool cards)
  const [scanConsent, setScanConsent] = useState(null); // null=unknown, true=given, false=not given
  const [toolOpenStates, setToolOpenStates] = useState({}); // toolId → {loading,error,message}
  const [extInfo, setExtInfo] = useState(null); // backend version-info (latest/min/forceUpdate)
  const [extNotice, setExtNotice] = useState(null); // admin-triggered "please update" notice (or null)
  // Snooze state for the extension-update banner. MANDATORY updates can only be
  // snoozed temporarily (timestamp); OPTIONAL updates can be dismissed for the
  // current latest version. Neither affects the tool-access gate (extMustUpdate)
  // below — snooze hides the banner only; outdated tools stay blocked if policy
  // requires it. Initialised from localStorage so a snooze survives re-renders.
  const [extSnoozeUntil, setExtSnoozeUntil] = useState(0);         // mandatory-update snooze (timestamp)
  const [softSnoozeUntil, setSoftSnoozeUntil] = useState(0);       // optional-update snooze (timestamp)
  const [softSnoozeVersion, setSoftSnoozeVersion] = useState(null); // version the optional snooze applies to
  const [showMandatoryModal, setShowMandatoryModal] = useState(false); // one-time blocking modal (mandatory update only)
  // Refs used by the lightweight notification poll so its identity stays stable
  // (the extension bridge updates its version frequently during detection — we
  // must not tear down/recreate the poll interval on every heartbeat).
  const installedVersionRef = useRef(null);
  const seenAnnouncementIdsRef = useRef(null); // Set of announcement ids seen so far (null until first load)

  // Detect outdated extension at the DASHBOARD level (works for ALL installed
  // versions, including old builds that lack heartbeat update-awareness). Fetch
  // the latest published version + policy, passing the installed version so the
  // backend returns a ready decision.
  const installedExtVersion = extConnStatus?.version || null;
  useEffect(() => {
    let alive = true;
    getLatestExtension(installedExtVersion).then(info => { if (alive) setExtInfo(info); }).catch(() => {});
    return () => { alive = false; };
  }, [installedExtVersion]);

  // Admin-triggered update request (self-clears server-side once the client is on
  // the latest version). Only enriches the existing update banner's wording.
  useEffect(() => {
    let alive = true;
    api.get('/client/extension-notice')
      .then(r => { if (alive) setExtNotice(r.data?.notice || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [installedExtVersion]);

  // Keep the installed-version ref fresh for the poll (cheap, every render).
  installedVersionRef.current = installedExtVersion;

  // ── Per-client announcement snooze storage ─────────────────────────────────
  // Dismissals are stored PER CLIENT (keyed by the signed-in client id) so one
  // member closing a notice never hides it for another sharing the browser.
  // A dismissal is a TIMED SNOOZE, not permanent: we store { id: showAgainAt },
  // so a closed announcement re-appears automatically once ANNOUNCE_SNOOZE_MS
  // has elapsed (the 45s poll brings it back — no refresh).
  const announceKey = useCallback(() => {
    const u = authService.getCurrentUser();
    const id = u?.id || u?._id || u?.email || 'anon';
    return `announce_snooze_v2_${id}`;
  }, []);
  const getDismissedAnnouncementIds = useCallback(() => {
    const out = new Set();
    try {
      const map = JSON.parse(localStorage.getItem(announceKey()) || '{}');
      const now = Date.now();
      Object.keys(map).forEach(id => { if (map[id] > now) out.add(id); }); // still snoozed only
    } catch (_) {}
    return out;
  }, [announceKey]);
  const extSnoozeKey = useCallback(() => {
    const u = authService.getCurrentUser();
    const id = u?.id || u?._id || u?.email || 'anon';
    return { snooze: `ext_update_snooze_until_${id}`, soft: `ext_soft_update_dismissed_version_${id}` };
  }, []);

  // Restore any persisted snooze (mandatory + optional) once on mount.
  useEffect(() => {
    try {
      const k = extSnoozeKey();
      const snz = parseInt(localStorage.getItem(k.snooze) || '0', 10);
      if (snz) setExtSnoozeUntil(snz);
      const soft = JSON.parse(localStorage.getItem(k.soft) || 'null');
      if (soft && soft.until) { setSoftSnoozeUntil(soft.until); setSoftSnoozeVersion(soft.version || null); }
    } catch (_) { /* ignore */ }
  }, [extSnoozeKey]);

  // Recompute the decision client-side too, so it's correct regardless of which
  // installed version the backend saw (semantic compare — never string compare).
  const extLatest = extInfo?.latest || null;
  const extOutdated = !!(installedExtVersion && extLatest && isOlder(installedExtVersion, extLatest));
  const extMustUpdate = !!(
    extInfo && installedExtVersion && (
      extInfo.updateRequired ||
      (extInfo.forceUpdate && extOutdated) ||
      (extInfo.minVersion && isOlder(installedExtVersion, extInfo.minVersion))
    )
  );
  // Optional (non-forced) update available — a gentle nudge, never blocks access.
  const extSoftUpdate = extOutdated && !extMustUpdate;

  // Banner visibility (snooze-aware). IMPORTANT: this gates the BANNER only — the
  // tool-access gate keeps using extMustUpdate, so snoozing a mandatory update
  // never unblocks outdated tools. Mandatory → temporary 15-min snooze (re-shows
  // automatically via the poll once it lapses, or on the next visit). Optional →
  // dismissed for the current latest version only (re-shows when a newer version
  // ships).
  const nowTs = Date.now();
  const extUpdateSnoozed = extMustUpdate
    ? (extSnoozeUntil > nowTs)
    // Optional: hidden only while the snooze is live AND still for this version
    // (a newer release re-shows it immediately; an elapsed snooze re-shows it too).
    : (extSoftUpdate && softSnoozeVersion === extLatest && softSnoozeUntil > nowTs);
  const showExtUpdateBanner = extOutdated && !extUpdateSnoozed;

  const snoozeExtUpdate = useCallback(() => {
    const k = extSnoozeKey();
    if (extMustUpdate) {
      const until = Date.now() + EXT_MANDATORY_SNOOZE_MS;
      try { localStorage.setItem(k.snooze, String(until)); } catch (_) {}
      setExtSnoozeUntil(until);
    } else {
      const until = Date.now() + EXT_OPTIONAL_SNOOZE_MS;
      try { localStorage.setItem(k.soft, JSON.stringify({ until, version: extLatest || '' })); } catch (_) {}
      setSoftSnoozeUntil(until);
      setSoftSnoozeVersion(extLatest || null);
    }
  }, [extMustUpdate, extLatest, extSnoozeKey]);

  // One-time blocking modal for MANDATORY updates only. Shows ONCE per browser
  // session (sessionStorage) so it grabs attention without nagging on every 5-min
  // snooze — the persistent banner + blocked tool access carry the reminder after
  // that. Optional updates and announcements never trigger this modal.
  useEffect(() => {
    if (!extMustUpdate) return;
    try {
      if (sessionStorage.getItem('ext_mandatory_modal_shown') === '1') return;
      sessionStorage.setItem('ext_mandatory_modal_shown', '1');
    } catch (_) { /* sessionStorage unavailable → just show once in-memory */ }
    setShowMandatoryModal(true);
  }, [extMustUpdate]);

  // Esc closes the modal (it is a temporary dismiss only — tools stay blocked).
  useEffect(() => {
    if (!showMandatoryModal) return;
    const onKey = (e) => { if (e.key === 'Escape') setShowMandatoryModal(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showMandatoryModal]);

  // De-duplication: the extension update banner above is the single source of truth
  // for "please update the extension". When it is showing, suppress any admin
  // announcement that is just another extension-update notice so the same message
  // never appears twice in a confusing way (req: avoid duplicate update messages).
  const isExtUpdateAnnouncement = (a) => {
    const txt = `${a?.title || ''} ${a?.body || ''}`.toLowerCase();
    return /\bextension\b/.test(txt) && /(update|upgrade|new version|latest version|outdated|v\d)/.test(txt);
  };

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [toolsRes, expiringRes, annRes] = await Promise.all([
        api.get('/client/tools'),
        api.get('/client/assignments/expiring'),
        api.get('/client/announcements').catch(() => ({ data: {} }))
      ]);
      setTools(toolsRes.data.tools || []);
      setExpiringTools(expiringRes.data.expiring || []);
      const dismissed = getDismissedAnnouncementIds();
      const annList = (annRes.data?.announcements || []).filter(a => !dismissed.has(a._id));
      setAnnouncements(annList);
      // Baseline the "seen" set so the background poll only toasts for genuinely
      // new announcements that arrive AFTER this initial load.
      seenAnnouncementIdsRef.current = new Set(annList.map(a => a._id));
      if (expiringRes.data.expiring?.length > 0) {
        const expiryDismissed = localStorage.getItem('expiry_warning_dismissed');
        const dismissedTime = expiryDismissed ? new Date(expiryDismissed) : null;
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
  }, [navigate, showError, getDismissedAnnouncementIds]);

  useEffect(() => { loadData(); }, [loadData]);

  const dismissAnnouncement = useCallback((id) => {
    try {
      const k = announceKey();
      const map = JSON.parse(localStorage.getItem(k) || '{}');
      map[id] = Date.now() + ANNOUNCE_SNOOZE_MS; // re-show after the snooze window
      localStorage.setItem(k, JSON.stringify(map));
    } catch (_) { /* ignore */ }
    setAnnouncements(a => a.filter(x => x._id !== id));
  }, [announceKey]);

  // ── Real-time notification poll (no page refresh) ──────────────────────────
  // Lightweight: re-reads the SAME existing endpoints the dashboard already uses
  // (announcements, the admin "please update" notice, and the published version
  // info) on a 45s interval and whenever the tab regains focus. New admin
  // announcements and "Notify update" flags therefore appear automatically. This
  // never toggles the loading skeleton, never re-fetches tools, and reuses the
  // dismissed/snooze state — so there is no second notification system and no
  // duplicate cards (the announcement list is replaced wholesale, keyed by _id).
  const pollNotifications = useCallback(async () => {
    // 1) Announcements — replace wholesale (dedupes), honour per-client dismissals.
    try {
      const r = await api.get('/client/announcements');
      const dismissed = getDismissedAnnouncementIds();
      const list = (r.data?.announcements || []).filter(a => !dismissed.has(a._id));
      setAnnouncements(list);
      // Toast only for genuinely NEW announcements (baseline set on first load).
      const seen = seenAnnouncementIdsRef.current;
      if (seen) {
        const fresh = list.filter(a => !seen.has(a._id));
        if (fresh.length === 1) showInfo(`New announcement: ${fresh[0].title}`);
        else if (fresh.length > 1) showInfo(`${fresh.length} new announcements`);
        fresh.forEach(a => seen.add(a._id));
      } else {
        seenAnnouncementIdsRef.current = new Set(list.map(a => a._id));
      }
    } catch (_) { /* fail-safe: never disrupt the dashboard */ }
    // 2) Admin "please update" notice (self-clears server-side once up to date).
    api.get('/client/extension-notice').then(r => setExtNotice(r.data?.notice || null)).catch(() => {});
    // 3) Published version info — re-evaluates outdated / mandatory client-side.
    getLatestExtension(installedVersionRef.current).then(info => setExtInfo(info)).catch(() => {});
  }, [getDismissedAnnouncementIds, showInfo]);

  useEffect(() => {
    const POLL_MS = 45000;
    const id = setInterval(() => { pollNotifications(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') pollNotifications(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [pollNotifications]);

  // Urgent expiry toast: if any active tool has 1–3 days left, warn once per day.
  useEffect(() => {
    if (!tools.length) return;
    const urgent = tools
      .filter(t => t.status !== 'expired' && typeof t.daysUntilExpiry === 'number' && t.daysUntilExpiry >= 1 && t.daysUntilExpiry <= 3)
      .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry)[0];
    if (!urgent) return;
    const key = `expiry_urgent_toast_${new Date().toDateString()}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    const d = urgent.daysUntilExpiry;
    showWarning(`Your access to ${urgent.name} expires in ${d} day${d === 1 ? '' : 's'}. Please renew or contact support.`, 9000);
  }, [tools, showWarning]);

  // Check scanner consent once bridge is ready
  useEffect(() => {
    if (!bridgeReady) return;
    getScanStatus().then(s => setScanConsent(!!s?.consentGiven)).catch(() => {});
  }, [bridgeReady, getScanStatus]);

  const dismissExpiryWarning = () => {
    setShowExpiryWarning(false);
    localStorage.setItem('expiry_warning_dismissed', new Date().toISOString());
  };

  // Derive stats. These iterate the tools list; memoize so the frequent
  // extension-status re-renders don't re-run the filter/sort each tick (only
  // recompute when the underlying data or search/filter actually changes).
  const activeTools   = useMemo(() => tools.filter(t => t.status !== 'expired'), [tools]);
  // Proxy tools (HIX/BypassGPT/ChatGPT/Ryne/WriteHuman) and StealthWriter are assigned
  // tools too — count their ACTIVE ones in the Active Tools total so the number matches
  // what the member actually sees as tool cards.
  const proxyActiveCount = (proxyTools || []).filter(pt => pt && pt.active).length;
  const stealthActiveCount = (stealth?.hasPlan && (stealth.plan ? (stealth.plan.active !== false && !stealth.plan.expired) : true)) ? 1 : 0;
  const totalActiveTools = activeTools.length + proxyActiveCount + stealthActiveCount;
  const featuredTools = useMemo(() => tools.filter(t => t.isFeatured && t.status !== 'expired').slice(0, 4), [tools]);

  // Expiring Soon — computed from real assignment data (backend daysUntilExpiry,
  // which mirrors effectiveEndBoundary). Within 7 days, excludes expired.
  const expiringSoon = useMemo(() => activeTools
    .filter(t => typeof t.daysUntilExpiry === 'number' && t.daysUntilExpiry >= 0 && t.daysUntilExpiry <= 7)
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry), [activeTools]);
  const nearestExpiry = expiringSoon[0] || null;
  const fmtExpiry = (d) => {
    if (!d) return null;
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  // Unique categories
  const categories = useMemo(() => ['All', ...new Set(tools.map(t => t.category).filter(Boolean))], [tools]);

  // Filter tools
  const filteredTools = useMemo(() => tools.filter(t => {
    const matchesSearch = !searchQuery ||
      t.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.category?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.shortDescription?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = activeFilter === 'All' || t.category === activeFilter;
    return matchesSearch && matchesFilter;
  }), [tools, searchQuery, activeFilter]);

  // StealthWriter appears as a normal tool card when assigned; respect search/filter.
  const stealthMatches = (() => {
    if (!stealth?.hasPlan) return false;
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q || 'stealthwriter humanizer ai detector humanize'.includes(q);
    const matchesFilter = activeFilter === 'All' || activeFilter === 'AI' || activeFilter === 'Text Humanizers';
    return matchesSearch && matchesFilter;
  })();

  // HIX AI / BypassGPT appear as normal tool cards when assigned; respect search/filter.
  const proxyMatches = (proxyTools || []).filter(pt => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q || `${pt.name} ${pt.tagline || ''} humanizer ai detector`.toLowerCase().includes(q);
    const matchesFilter = activeFilter === 'All' || activeFilter === 'AI' || activeFilter === 'Text Humanizers';
    return matchesSearch && matchesFilter;
  });

  /* ─── sanitizeError — maps raw extension/backend errors to user-safe messages ─ */
  const sanitizeError = useCallback((result) => {
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
    // Extension is below the required minimum version — must update first.
    if (result?.error === 'extension_update_required' || /extension is outdated|update.*extension/i.test(raw)) {
      return 'Your extension is outdated. Please download and install the latest version to continue.';
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
  }, []);

  /* ─── handleOpenTool ─ */
  const handleOpenTool = useCallback(async (tool) => {
    const toolId = tool._id || tool.toolId;
    if (!toolId) return;

    // Frontend guard: never attempt to open an expired tool. The backend also
    // blocks expired access (assignment_expired / 403), so this just avoids a
    // pointless round-trip and shows a clear message.
    if (tool.status === 'expired') {
      setToolOpenStates(prev => ({ ...prev, [toolId]: { error: 'Access expired. Contact admin to renew.' } }));
      return;
    }

    // Forced-update gate: if the installed extension is below the required
    // minimum (or update_required is set), block opening until they update. The
    // backend credentials endpoint enforces this too (defense-in-depth).
    if (extMustUpdate) {
      setToolOpenStates(prev => ({ ...prev, [toolId]: { error: 'Your extension is outdated. Please download and install the latest version to continue.' } }));
      return;
    }

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
  }, [bridgeReady, extMustUpdate, openTool, sanitizeError]);

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
      {/* ── One-time MANDATORY-update modal ── blocking, shown once per session.
          Optional updates / announcements never use this (they stay banner+toast).
          Closing is a temporary dismiss only — tool access stays blocked via
          extMustUpdate, and the persistent banner keeps reminding. ── */}
      {showMandatoryModal && extMustUpdate && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4"
             role="dialog" aria-modal="true" aria-labelledby="ext-update-modal-title"
             onClick={() => setShowMandatoryModal(false)}
             style={{ background: 'rgba(2,8,20,0.72)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
          <div onClick={(e) => e.stopPropagation()}
               className="relative w-full max-w-md rounded-2xl overflow-hidden"
               style={{
                 background: 'linear-gradient(150deg, rgba(13,30,54,0.98), rgba(7,20,38,0.98))',
                 border: '1px solid rgba(248,113,113,0.40)',
                 boxShadow: '0 30px 80px -30px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
               }}>
            <div className="absolute -top-16 -right-12 w-64 h-40 pointer-events-none opacity-70"
                 style={{ background: 'radial-gradient(closest-side, rgba(248,113,113,0.28), transparent 70%)' }} />
            <button onClick={() => setShowMandatoryModal(false)} aria-label="Remind me later"
                    className="absolute top-3 right-3 z-10 text-white/45 hover:text-white transition-colors">
              <X size={18} />
            </button>
            <div className="relative p-6">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
                   style={{ background: 'linear-gradient(135deg,#ef4444,#b91c1c)', boxShadow: '0 10px 24px -8px rgba(239,68,68,0.7)' }}>
                <RefreshCw size={22} className="text-white" />
              </div>
              <h2 id="ext-update-modal-title" className="font-heading text-[18px] font-extrabold text-white leading-tight">
                Extension update required
              </h2>
              <p className="text-[13px] text-white/70 mt-2 leading-relaxed">
                {extNotice?.message || 'A required update is available. Tool access stays paused until you install the latest version of the Gen Z Digital Store extension.'}
              </p>
              <div className="flex items-center gap-2 mt-4 flex-wrap">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-white/70"
                      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  Installed <span className="font-bold text-white">v{installedExtVersion || '—'}</span>
                </span>
                <ArrowRight size={14} className="text-white/40 flex-shrink-0" />
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-genz-cyan"
                      style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.32)' }}>
                  Latest <span className="font-bold text-white">v{extLatest}</span>
                </span>
              </div>
              <div className="flex items-center gap-2.5 mt-6">
                <a href={extZipUrl(extLatest)} download={versionedZipName(extLatest)} target="_blank" rel="noopener noreferrer"
                   onClick={() => setShowMandatoryModal(false)}
                   className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-bold text-white transition-all hover:-translate-y-0.5"
                   style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)', boxShadow: '0 12px 26px -10px rgba(37,99,235,0.8)' }}>
                  <Download size={15} /> Download Latest Extension
                </a>
                <button onClick={() => setShowMandatoryModal(false)}
                        className="px-4 py-2.5 rounded-xl text-[13px] font-semibold text-white/70 hover:text-white transition-colors"
                        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  Later
                </button>
              </div>
              <p className="text-[11px] text-white/40 mt-3">After updating, reload the extension and refresh this page.</p>
            </div>
          </div>
        </div>
      )}

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
            <RenewPlanLink
              status="expiring"
              className="flex-shrink-0 text-[11px] font-semibold text-amber-100 underline-offset-2 hover:underline">
              Renew
            </RenewPlanLink>
            <button onClick={dismissExpiryWarning} className="text-amber-200/60 hover:text-amber-100 transition-colors">
              <X size={13} />
            </button>
          </div>
        )}

        {/* ── Extension update banner (dashboard-detected; works for every
            installed version). The single, premium source of truth for the
            "update your extension" message — shows installed + latest version
            and a clear Download button. Downloads the latest from the EXISTING
            link with a versioned save-as filename. ── */}
        {showExtUpdateBanner && (
          <div className="relative overflow-hidden rounded-2xl px-4 sm:px-5 py-4"
               style={{
                 background: extMustUpdate
                   ? 'linear-gradient(120deg, rgba(40,12,16,0.96) 0%, rgba(15,42,73,0.95) 60%, rgba(6,60,74,0.92) 100%)'
                   : 'linear-gradient(120deg, rgba(7,27,51,0.96) 0%, rgba(15,42,73,0.95) 55%, rgba(6,78,89,0.92) 100%)',
                 border: extMustUpdate ? '1px solid rgba(248,113,113,0.40)' : '1px solid rgba(6,182,212,0.30)',
                 boxShadow: extMustUpdate
                   ? '0 16px 40px -22px rgba(248,113,113,0.5), inset 0 1px 0 rgba(255,255,255,0.06)'
                   : '0 16px 40px -22px rgba(6,182,212,0.55), inset 0 1px 0 rgba(255,255,255,0.07)',
                 backdropFilter: 'blur(10px)',
                 WebkitBackdropFilter: 'blur(10px)',
               }}>
            {/* glow accent */}
            <div className="absolute -top-14 -right-10 w-64 h-36 pointer-events-none opacity-70"
                 style={{ background: extMustUpdate
                   ? 'radial-gradient(closest-side, rgba(248,113,113,0.28), transparent 70%)'
                   : 'radial-gradient(closest-side, rgba(6,182,212,0.34), transparent 70%)' }} />
            {/* Close / snooze. Mandatory updates can only be snoozed temporarily
                (the banner returns after ~15 min or on next visit, and tool access
                stays blocked meanwhile); optional updates dismiss for this version. */}
            <button onClick={snoozeExtUpdate}
                    title={extMustUpdate ? 'Remind me later (update still required)' : 'Dismiss'}
                    aria-label={extMustUpdate ? 'Remind me later' : 'Dismiss update notice'}
                    className="absolute top-2.5 right-2.5 z-20 text-white/45 hover:text-white transition-colors">
              <X size={16} />
            </button>
            <div className="relative z-10 flex flex-col sm:flex-row sm:items-center gap-3.5 pr-6 sm:pr-7">
              {/* icon */}
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                   style={{ background: extMustUpdate ? 'linear-gradient(135deg,#ef4444,#b91c1c)' : 'linear-gradient(135deg, #2563EB, #06B6D4)',
                            boxShadow: extMustUpdate ? '0 8px 20px -8px rgba(239,68,68,0.7), inset 0 1px 0 rgba(255,255,255,0.2)' : '0 8px 20px -8px rgba(6,182,212,0.75), inset 0 1px 0 rgba(255,255,255,0.25)' }}>
                <RefreshCw size={20} className="text-white" />
              </div>
              {/* text + version chips */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-white text-[14.5px] leading-tight">
                    {extMustUpdate ? 'Extension update required' : 'Extension update available'}
                  </h3>
                  {extMustUpdate && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md text-[10px] font-bold"
                          style={{ background: 'rgba(248,113,113,0.16)', border: '1px solid rgba(248,113,113,0.40)', color: '#FCA5A5' }}>
                      Action needed
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-white/65 mt-1 leading-snug">
                  {extNotice
                    ? extNotice.message
                    : (extMustUpdate
                        ? 'Tool access is paused until you install the latest version.'
                        : 'A newer, more secure version is ready — update to keep one-click access running smoothly.')}
                </p>
                {/* installed → latest version chips */}
                <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                  <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold text-white/70"
                        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}>
                    Installed <span className="font-bold text-white">v{installedExtVersion || '—'}</span>
                  </span>
                  <ArrowRight size={13} className="text-white/40 flex-shrink-0" />
                  <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold text-genz-cyan"
                        style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.32)' }}>
                    Latest <span className="font-bold text-white">v{extLatest}</span>
                  </span>
                </div>
              </div>
              {/* action */}
              <div className="flex-shrink-0 sm:self-center">
                <a href={extZipUrl(extLatest)} download={versionedZipName(extLatest)} target="_blank" rel="noopener noreferrer"
                   className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[12.5px] font-bold text-white transition-all hover:-translate-y-0.5"
                   style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)', boxShadow: '0 10px 22px -10px rgba(37,99,235,0.75)' }}>
                  <Download size={14} /> Download Latest Extension
                </a>
              </div>
            </div>
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
                    <Package size={10} /> {totalActiveTools} tools
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
        {/* ── Announcements ── admin-posted notices (dismissible per device).
            Dark-glass cards with LIGHT text so they read clearly on the navy
            canvas (the old light-tinted .ds-card forced dark navy text onto a
            near-transparent dark surface → unreadable). When the extension
            update banner is showing, duplicate extension-update announcements
            are filtered out so the same message never appears twice. ── */}
        {(() => {
          // Hide duplicate "update your extension" announcements only while the
          // dedicated update banner is actually VISIBLE. If it is snoozed/hidden,
          // a genuine admin update announcement may still show (acts as the
          // lingering reminder, especially for mandatory updates).
          const visibleAnnouncements = showExtUpdateBanner
            ? announcements.filter(a => !isExtUpdateAnnouncement(a))
            : announcements;
          if (visibleAnnouncements.length === 0) return null;
          return (
          <div className="space-y-2">
            {visibleAnnouncements.map((a) => {
              const lv = a.level === 'success'
                ? { ring: 'rgba(52,211,153,0.34)', glow: 'rgba(16,185,129,0.30)', Icon: CheckCircle2, accent: '#6EE7B7', chip: 'rgba(52,211,153,0.14)' }
                : a.level === 'warning'
                  ? { ring: 'rgba(251,191,36,0.36)', glow: 'rgba(245,158,11,0.30)', Icon: AlertTriangle, accent: '#FCD34D', chip: 'rgba(251,191,36,0.14)' }
                  : { ring: 'rgba(6,182,212,0.34)', glow: 'rgba(37,99,235,0.30)', Icon: Sparkles, accent: '#67E8F9', chip: 'rgba(6,182,212,0.14)' };
              return (
                <div key={a._id}
                     className="relative overflow-hidden rounded-2xl flex items-start gap-3 px-4 py-3.5"
                     style={{
                       background: 'linear-gradient(120deg, rgba(7,27,51,0.96) 0%, rgba(12,38,66,0.95) 60%, rgba(6,52,66,0.92) 100%)',
                       border: `1px solid ${lv.ring}`,
                       boxShadow: `0 12px 30px -20px ${lv.glow}, inset 0 1px 0 rgba(255,255,255,0.05)`,
                     }}>
                  {/* level accent rail */}
                  <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: `linear-gradient(180deg, ${lv.accent}, transparent)` }} />
                  <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{ background: lv.chip, border: `1px solid ${lv.ring}`, color: lv.accent }}>
                    <lv.Icon size={15} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13.5px] font-bold text-white leading-snug">{a.title}</p>
                    {a.body && <p className="text-[12.5px] text-white/70 mt-1 leading-relaxed whitespace-pre-wrap break-words">{a.body}</p>}
                  </div>
                  <button onClick={() => dismissAnnouncement(a._id)} className="text-white/45 hover:text-white transition-colors flex-shrink-0 -mr-0.5" aria-label="Dismiss announcement">
                    <X size={15} />
                  </button>
                </div>
              );
            })}
          </div>
          );
        })()}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3">
          {(() => {
            const accountActive = !user?.expiryDate || new Date(user.expiryDate) > new Date();
            const cards = [
              { icon: CheckCircle2, kind: 'num',    value: totalActiveTools,     label: 'Active Tools',    sub: 'Ready to use',      color: '#16A34A' },
              { icon: Clock,        kind: 'num',    value: expiringSoon.length,  label: 'Expiring Soon',   sub: nearestExpiry ? `Soonest ${fmtExpiry(nearestExpiry.endDate)}` : 'Within 7 days', color: '#D97706' },
              { icon: ShieldCheck,  kind: 'status', value: accountActive ? 'Active' : 'Expired', badge: accountActive ? 'ds-badge-success' : 'ds-badge-danger', label: 'Account Status', sub: 'Membership',        color: accountActive ? '#16A34A' : '#EF4444' },
              { icon: Shield,       kind: 'status', value: 'Secured', badge: 'ds-badge-teal',     label: 'Device Security', sub: 'Encrypted bridge',  color: '#06B6D4' },
            ];
            return cards.map(({ icon: Icon, kind, value, label, sub, color, badge }) => (
              <div
                key={label}
                className="group relative overflow-hidden rounded-xl px-3 py-2.5 transition-all duration-300 hover:-translate-y-0.5"
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
                <div className="relative flex items-center gap-2.5 pl-1">
                  <span
                    className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-transform duration-300 group-hover:scale-105"
                    style={{
                      background: `linear-gradient(135deg, ${color}26, ${color}10)`,
                      color,
                      border: `1px solid ${color}40`,
                      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.55), 0 4px 10px -6px ${color}55`,
                    }}
                  >
                    <Icon size={14} strokeWidth={2.4} />
                  </span>
                  <div className="min-w-0 flex-1">
                    {kind === 'num' ? (
                      <div className="font-heading text-[20px] font-extrabold tabular-nums leading-none" style={{ color: '#071B33' }}>
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

        {/* ── Chrome Extension Banner ── premium glass strip, shown only while the
            extension is NOT yet detected. Once the bridge is present the extension
            is READY (the secure session is fetched on-demand when Access is
            clicked), so we never show a "connecting / disconnected" state.
            Install opens the member install page in a NEW TAB — the dashboard tab
            never reloads or navigates away. No dismiss control by design. */}
        {!bridgeReady && (
          <div className="relative overflow-hidden rounded-2xl px-4 sm:px-5 py-4"
               style={{
                 background: 'linear-gradient(120deg, rgba(7,27,51,0.96) 0%, rgba(15,42,73,0.95) 55%, rgba(6,78,89,0.92) 100%)',
                 border: '1px solid rgba(6,182,212,0.28)',
                 boxShadow: '0 16px 40px -22px rgba(6,182,212,0.55), inset 0 1px 0 rgba(255,255,255,0.07)',
                 backdropFilter: 'blur(10px)',
                 WebkitBackdropFilter: 'blur(10px)',
               }}>
            {/* glow accents */}
            <div className="absolute -top-14 -right-10 w-64 h-36 pointer-events-none opacity-70"
                 style={{ background: 'radial-gradient(closest-side, rgba(6,182,212,0.35), transparent 70%)' }} />
            <div className="absolute -bottom-16 left-1/4 w-64 h-32 pointer-events-none opacity-50"
                 style={{ background: 'radial-gradient(closest-side, rgba(37,99,235,0.28), transparent 70%)' }} />
            <div className="relative z-10 flex flex-col sm:flex-row sm:items-center gap-3.5">
              {/* icon */}
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                   style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)', boxShadow: '0 8px 20px -8px rgba(6,182,212,0.75), inset 0 1px 0 rgba(255,255,255,0.25)' }}>
                <Chrome size={20} className="text-white" />
              </div>
              {/* text */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-white text-[14.5px] leading-tight" data-testid="ext-banner-title">
                    {extConnStatus?.checking ? 'Checking for the extension…' : 'Install the Chrome Extension'}
                  </h3>
                  <span className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md text-[10px] font-bold text-genz-cyan"
                        style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.30)' }}>
                    <ShieldCheck size={10} /> Secure
                  </span>
                </div>
                <p className="text-[12px] text-white/65 mt-1 leading-snug">
                  One-click access to all your tools — already signed in. Install once and you're set.
                </p>
              </div>
              {/* action */}
              <div className="flex-shrink-0 sm:self-center">
                {!extConnStatus?.checking ? (
                  <a href={extZipUrl(extLatest)} download={versionedZipName(extLatest)} target="_blank" rel="noopener noreferrer"
                     onClick={verifyExtensionDownload}
                     data-testid="ext-banner-install"
                     className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[12.5px] font-bold text-white transition-all hover:-translate-y-0.5"
                     style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)', boxShadow: '0 10px 22px -10px rgba(37,99,235,0.75)' }}>
                    <Download size={14} /> Install Extension
                  </a>
                ) : (
                  <span className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-[12.5px] font-semibold text-genz-cyan"
                        style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.30)' }}>
                    <Loader2 size={14} className="animate-spin" /> Detecting…
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Extension installed → compact connected/synced status strip */}
        {bridgeReady && (
          <div className="relative overflow-hidden rounded-2xl px-4 sm:px-5 py-3"
               style={{
                 background: 'linear-gradient(120deg, rgba(7,27,51,0.96) 0%, rgba(6,78,89,0.9) 100%)',
                 border: '1px solid rgba(52,211,153,0.32)',
                 boxShadow: '0 12px 30px -20px rgba(52,211,153,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
               }}>
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(52,211,153,0.16)', border: '1px solid rgba(52,211,153,0.4)', color: '#34D399' }}>
                <ShieldCheck size={18} />
              </span>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-white text-[13.5px] leading-tight flex items-center gap-2">
                  Extension connected
                  <span className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md text-[10px] font-bold" style={{ background: 'rgba(52,211,153,0.16)', border: '1px solid rgba(52,211,153,0.38)', color: '#6EE7B7' }}>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Synced
                  </span>
                </h3>
                <p className="text-[12px] text-white/60 mt-0.5 leading-snug">Your tools open securely in one click — you're all set.</p>
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
          <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mb-4">
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
                        className={`flex-shrink-0 px-3 py-2 rounded-lg text-[12px] font-semibold transition-all ${
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
          {filteredTools.length === 0 && !stealthMatches && proxyMatches.length === 0 && !stealthLoading ? (
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
            <div className="grid gap-3"
                 style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 250px), 300px))', justifyContent: 'start' }}>
              {stealthMatches && <StealthWriterCard stealth={stealth} />}
              {proxyMatches.map(pt => <ProxyToolCard key={pt.tool} tool={pt} />)}
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
           className="ds-card ds-stat group relative overflow-hidden flex items-center gap-3 p-3.5">
          <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: 'linear-gradient(90deg,#22c55e,#06B6D4)' }} />
          <span className="w-10 h-10 rounded-lg flex items-center justify-center text-white flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#22c55e,#16a34a)', boxShadow: '0 6px 14px -8px rgba(34,197,94,0.6)' }}>
            <MessageCircle size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <h4 className="text-[13.5px] font-bold text-genz-navy flex items-center gap-2">
              WhatsApp Support <span className="ds-badge ds-badge-success !text-[10.5px] !py-[2px] !px-2"><span className="dot" /> Online</span>
            </h4>
            <p className="text-[12px] text-genz-muted mt-0.5 leading-snug">Chat with our team for help, tool requests, or a new order — fast replies.</p>
          </div>
          <span className="hidden sm:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[10px] text-[12.5px] font-bold text-white"
                style={{ background: 'linear-gradient(135deg,#22c55e,#16a34a)' }}>
            Chat now <ArrowRight size={14} />
          </span>
        </a>

        {/* ── Quick actions ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { icon: Chrome, title: 'Extension Setup',  desc: extSoftUpdate ? 'A newer extension version is available — download to update.' : 'Download the Chrome extension for one-click tool access.', to: extZipUrl(extLatest), cta: extSoftUpdate ? 'Update' : 'Download', grad: 'linear-gradient(135deg,#2563EB,#06B6D4)', download: true, badge: extSoftUpdate ? 'Update available' : null },
            { icon: Shield, title: 'Account Security', desc: 'Manage device binding and your security settings.',         to: '/client/profile', cta: 'Manage',   grad: 'linear-gradient(135deg,#0891B2,#14B8A6)' },
            { icon: Zap,    title: 'Need More Tools?', desc: 'Upgrade your membership to unlock all 90+ tools.',          to: '/pricing',        cta: 'Upgrade',  grad: 'linear-gradient(135deg,#4F46E5,#2563EB)' },
          ].map(({ icon: Icon, title, desc, to, cta, grad, download, badge }) => {
            const cardClass = 'ds-card ds-stat p-4 flex flex-col group';
            const inner = (
              <>
                <span className="w-9 h-9 rounded-lg flex items-center justify-center text-white mb-2.5" style={{ background: grad, boxShadow: '0 6px 14px -8px rgba(37,99,235,0.5)' }}>
                  <Icon size={17} />
                </span>
                <h4 className="text-[13.5px] font-bold text-genz-navy group-hover:text-genz-blue transition-colors flex items-center gap-1.5">
                  {title}{badge && <span className="ds-badge ds-badge-warn !text-[9.5px] !py-[1px] !px-1.5">{badge}</span>}
                </h4>
                <p className="text-[12px] text-genz-muted mt-0.5 leading-snug flex-1">{desc}</p>
                <span className="inline-flex items-center gap-1.5 mt-2.5 text-[12.5px] text-genz-blue font-semibold group-hover:gap-2.5 transition-all">
                  {cta} <ArrowRight size={13} />
                </span>
              </>
            );
            // The extension entry downloads the static ZIP directly (new tab),
            // so it never routes through the auth-gated /chrome-extension page.
            return download ? (
              <a key={title} href={to} download={versionedZipName(extLatest)} target="_blank" rel="noopener noreferrer" onClick={verifyExtensionDownload} className={cardClass}>
                {inner}
              </a>
            ) : (
              <Link key={title} to={to} className={cardClass}>{inner}</Link>
            );
          })}
        </div>

      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientDashboardEnhanced;
