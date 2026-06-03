import { useState, useEffect, useCallback } from 'react';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import {
  ShieldAlert, AlertTriangle, CheckCircle2, Eye, RefreshCw, Filter,
  User, Clock, Monitor, Globe, Zap, ChevronDown, X,
  Lock, LogOut, Smartphone, UserX, Flag, Info
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

// ── Risk level styling ───────────────────────────────────────────────────────
const RISK_STYLES = {
  critical: { bg: 'bg-red-500/15',    border: 'border-red-500/40',    text: 'text-red-400',    dot: 'bg-red-500'    },
  high:     { bg: 'bg-orange-500/15', border: 'border-orange-500/40', text: 'text-orange-400', dot: 'bg-orange-500' },
  medium:   { bg: 'bg-yellow-500/15', border: 'border-yellow-500/40', text: 'text-yellow-400', dot: 'bg-yellow-500' },
  low:      { bg: 'bg-blue-500/15',   border: 'border-blue-500/40',   text: 'text-blue-400',   dot: 'bg-blue-500'   },
};

const STATUS_STYLES = {
  open:          'bg-red-500/15 text-red-400',
  reviewed:      'bg-yellow-500/15 text-yellow-400',
  resolved:      'bg-green-500/15 text-green-400',
  false_positive:'bg-gray-500/15 text-gray-400',
};

const RISK_TYPE_LABELS = {
  NEW_DEVICE:                 'New Device',
  DEVICE_MISMATCH:            'Device Mismatch',
  IP_CHANGE:                  'IP/Location Change',
  REVOKED_TOKEN_USE:          'Revoked Token Used',
  MULTIPLE_ACTIVE_SESSIONS:   'Multiple Sessions',
  ABNORMAL_ACCESS_FREQUENCY:  'Abnormal Access Rate',
  EXPIRED_ACCESS_ATTEMPT:     'Expired Access Attempt',
  REPEATED_AUTH_FAILURE:      'Repeated Auth Failures',
  RISKY_EXTENSION_DETECTED:   'Risky Browser Extension',
  ADMIN_ACTION:               'Admin Action',
};

const ACTION_CONFIGS = [
  { id: 'reviewed',         label: 'Mark Reviewed',      icon: Eye,        color: 'text-blue-400',   desc: 'Acknowledge — no action needed' },
  { id: 'token_revoked',    label: 'Revoke Ext Token',   icon: Lock,       color: 'text-orange-400', desc: 'Disconnect all extension sessions' },
  { id: 'client_logged_out',label: 'Force Logout',       icon: LogOut,     color: 'text-yellow-400', desc: 'Invalidate all web sessions' },
  { id: 'device_reset',     label: 'Reset Device',       icon: Smartphone, color: 'text-purple-400', desc: 'Remove device binding — re-bind on next login' },
  { id: 'client_disabled',  label: 'Disable Account',    icon: UserX,      color: 'text-red-400',    desc: 'Immediately block all access' },
  { id: 'marked_false_positive', label: 'False Positive', icon: Flag,      color: 'text-gray-400',   desc: 'Dismiss — expected behaviour' },
];

// ── Alert detail modal ────────────────────────────────────────────────────────
const AlertDetailModal = ({ alert, onClose, onAction }) => {
  const [selectedAction, setSelectedAction] = useState('');
  const [notes, setNotes] = useState('');
  const [acting, setActing] = useState(false);
  const { showSuccess, showError } = useToast();
  if (!alert) return null;

  const risk = RISK_STYLES[alert.riskLevel] || RISK_STYLES.medium;
  const ctx  = alert.context || {};

  const handleAction = async () => {
    if (!selectedAction) return;
    setActing(true);
    try {
      await api.post(`/admin/security-alerts/${alert._id}/action`, { action: selectedAction, notes });
      showSuccess('Action completed');
      onAction();
      onClose();
    } catch (e) {
      showError(e.response?.data?.error || 'Action failed');
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
         style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-2xl rounded-2xl border shadow-2xl overflow-hidden"
           style={{ background: '#001030', borderColor: 'rgba(0,175,193,0.2)' }}>

        {/* Header */}
        <div className={`flex items-start justify-between p-5 border-b ${risk.bg} ${risk.border}`}
             style={{ borderColor: undefined }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2.5 h-2.5 rounded-full ${risk.dot}`} />
              <span className={`text-xs font-bold uppercase tracking-wider ${risk.text}`}>
                {alert.riskLevel} risk
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLES[alert.status]}`}>
                {alert.status}
              </span>
            </div>
            <h2 className="text-white font-bold text-lg">
              {RISK_TYPE_LABELS[alert.riskType] || alert.riskType}
            </h2>
          </div>
          <button onClick={onClose} className="text-genz-muted hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Client */}
          <div className={`${ADMIN_CARD_VARIANTS.default} p-4 rounded-xl`}>
            <p className="text-xs text-genz-muted mb-2 font-medium uppercase tracking-wider">Member</p>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold text-genz-deep-navy"
                   style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}>
                {(alert.clientId?.fullName || 'U').charAt(0)}
              </div>
              <div>
                <p className="text-white font-semibold text-sm">{alert.clientId?.fullName || '—'}</p>
                <p className="text-genz-muted text-xs">{alert.clientId?.email || '—'}</p>
              </div>
              <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${
                alert.clientId?.status === 'active' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
              }`}>{alert.clientId?.status || '—'}</span>
            </div>
          </div>

          {/* Context */}
          <div className={`${ADMIN_CARD_VARIANTS.default} p-4 rounded-xl`}>
            <p className="text-xs text-genz-muted mb-3 font-medium uppercase tracking-wider">Context</p>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Device Hash',    ctx.deviceIdHash?.slice(0, 16) + '…' || '—'],
                ['IP Address',     ctx.ipAddress || '—'],
                ['Browser/OS',     ctx.userAgent ? ctx.userAgent.slice(0, 60) + '…' : '—'],
                ['Ext Version',    ctx.extensionVersion || '—'],
                ['Tool',           ctx.toolName || '—'],
                ['Timestamp',      new Date(alert.createdAt).toLocaleString()],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-genz-muted text-xs">{label}</p>
                  <p className="text-white font-mono text-xs mt-0.5 break-all">{value}</p>
                </div>
              ))}
            </div>
            {ctx.details && (
              <div className="mt-3 p-3 rounded-lg bg-white/[0.03] border border-white/5">
                <p className="text-genz-muted text-xs mb-1">Details</p>
                <p className="text-white/80 text-xs leading-relaxed">{ctx.details}</p>
              </div>
            )}
          </div>

          {/* Risky extensions (if present) */}
          {ctx.riskyExtensions?.length > 0 && (
            <div className={`${ADMIN_CARD_VARIANTS.default} p-4 rounded-xl`}>
              <div className="flex items-center gap-2 mb-3">
                <Info size={14} className="text-yellow-400" />
                <p className="text-xs font-medium text-yellow-400 uppercase tracking-wider">
                  Risky Extensions Detected
                </p>
              </div>
              <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 mb-3">
                <p className="text-xs text-yellow-300 leading-relaxed">
                  ⚠️ These extensions have permissions that <em>could</em> allow access to browser session data.
                  This is a risk indicator only — we cannot confirm data was copied. Review with the member if concerned.
                </p>
              </div>
              {ctx.riskyExtensions.map((ext, i) => (
                <div key={i} className="flex items-start gap-3 py-2 border-b border-white/5 last:border-0">
                  <div className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 ${
                    ext.riskLevel === 'high' ? 'bg-red-500/15 text-red-400' : 'bg-yellow-500/15 text-yellow-400'
                  }`}>{ext.riskLevel}</div>
                  <div className="min-w-0">
                    <p className="text-white text-xs font-medium truncate">{ext.extName}</p>
                    <p className="text-genz-muted text-xs font-mono">{ext.extId}</p>
                    <p className="text-genz-muted text-xs mt-0.5">Permissions: {ext.permissionsSummary}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Action panel */}
          {alert.status === 'open' && (
            <div className={`${ADMIN_CARD_VARIANTS.default} p-4 rounded-xl`}>
              <p className="text-xs text-genz-muted mb-3 font-medium uppercase tracking-wider">Recommended Action</p>
              <div className="space-y-2 mb-4">
                {ACTION_CONFIGS.map(({ id, label, icon: Icon, color, desc }) => (
                  <label key={id}
                         className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer border transition-all ${
                           selectedAction === id
                             ? 'border-genz-teal/50 bg-genz-teal/5'
                             : 'border-white/5 hover:border-white/15'
                         }`}>
                    <input type="radio" name="action" value={id} className="sr-only"
                           onChange={() => setSelectedAction(id)} />
                    <Icon size={15} className={color} />
                    <div className="flex-1">
                      <p className={`text-sm font-medium ${selectedAction === id ? 'text-white' : 'text-white/70'}`}>{label}</p>
                      <p className="text-genz-muted text-xs">{desc}</p>
                    </div>
                    {selectedAction === id && <div className="w-2 h-2 rounded-full bg-genz-teal" />}
                  </label>
                ))}
              </div>
              <textarea
                placeholder="Admin notes (optional)…"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 rounded-xl text-xs text-white placeholder-genz-muted resize-none focus:outline-none mb-3"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,175,193,0.15)' }}
              />
              <button onClick={handleAction} disabled={!selectedAction || acting}
                      className="w-full py-2.5 rounded-xl text-sm font-bold text-genz-deep-navy disabled:opacity-40 transition-all hover:opacity-90"
                      style={{ background: 'linear-gradient(135deg,#00AFC1,#008EA3)' }}>
                {acting ? 'Processing…' : 'Execute Action'}
              </button>
            </div>
          )}

          {/* Already resolved */}
          {alert.status !== 'open' && alert.reviewedAt && (
            <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/20 text-sm">
              <p className="text-green-400 font-medium">Resolved by {alert.reviewedBy?.fullName || 'Admin'}</p>
              <p className="text-genz-muted text-xs mt-1">
                {new Date(alert.reviewedAt).toLocaleString()} — {alert.actionTaken}
              </p>
              {alert.reviewNotes && <p className="text-white/70 text-xs mt-1">"{alert.reviewNotes}"</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Main Admin Security Alerts page ──────────────────────────────────────────
const AdminSecurityAlerts = () => {
  const { showError } = useToast();
  const [alerts, setAlerts]       = useState([]);
  const [stats, setStats]         = useState({});
  const [loading, setLoading]     = useState(true);
  const [selectedAlert, setSelectedAlert] = useState(null);
  const [filters, setFilters]     = useState({ status: 'open', riskLevel: '', riskType: '' });
  const [page, setPage]           = useState(1);
  const [total, setTotal]         = useState(0);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ page, limit: 25, ...filters });
      // Remove empty filters
      ['status','riskLevel','riskType'].forEach(k => { if (!filters[k]) params.delete(k); });
      const res = await api.get(`/admin/security-alerts?${params}`);
      setAlerts(res.data.alerts || []);
      setStats(res.data.stats  || {});
      setTotal(res.data.total  || 0);
    } catch (e) {
      showError('Failed to load security alerts');
    } finally {
      setLoading(false);
    }
  }, [filters, page, showError]);

  useEffect(() => { load(); }, [load]);

  const risk = (level) => RISK_STYLES[level] || RISK_STYLES.medium;

  return (
    <AdminLayoutEnhanced>
      <div className="space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-black text-white flex items-center gap-2">
              <ShieldAlert size={22} className="text-genz-teal" />
              Security Alerts
            </h1>
            <p className="text-genz-muted text-sm mt-1">
              Risk events detected by the server-side Risk Engine and optional extension scanner.
            </p>
          </div>
          <button onClick={load}
                  className="p-2 rounded-xl border border-white/10 text-genz-muted hover:text-genz-teal hover:border-genz-teal/30 transition-all">
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Open Alerts',    value: stats.openCount  ?? '—', color: 'text-red-400',    icon: AlertTriangle },
            { label: 'High / Critical',value: stats.highCount  ?? '—', color: 'text-orange-400', icon: ShieldAlert   },
            { label: 'Last 24 Hours',  value: stats.todayCount ?? '—', color: 'text-genz-teal',  icon: Clock         },
          ].map(({ label, value, color, icon: Icon }) => (
            <div key={label} className={`${ADMIN_CARD_VARIANTS.default} p-4 rounded-2xl`}>
              <Icon size={16} className={`${color} mb-2`} />
              <div className={`text-2xl font-black ${color}`}>{value}</div>
              <div className="text-xs text-genz-muted mt-0.5">{label}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          {[
            { key: 'status', options: [['', 'All Statuses'], ['open', 'Open'], ['reviewed', 'Reviewed'], ['resolved', 'Resolved'], ['false_positive', 'False Positive']] },
            { key: 'riskLevel', options: [['', 'All Levels'], ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']] },
            { key: 'riskType', options: [['', 'All Types'], ...Object.entries(RISK_TYPE_LABELS)] },
          ].map(({ key, options }) => (
            <div key={key} className="relative">
              <select
                value={filters[key]}
                onChange={e => { setFilters(f => ({ ...f, [key]: e.target.value })); setPage(1); }}
                className="appearance-none pl-3 pr-8 py-2 rounded-xl text-sm text-white focus:outline-none cursor-pointer"
                style={{ background: 'rgba(0,175,193,0.08)', border: '1px solid rgba(0,175,193,0.2)' }}>
                {options.map(([v, l]) => <option key={v} value={v} style={{ background: '#001030' }}>{l}</option>)}
              </select>
              <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" />
            </div>
          ))}
        </div>

        {/* Alerts table */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 rounded-full border-2 border-genz-teal border-t-transparent animate-spin" />
          </div>
        ) : alerts.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.default} p-12 rounded-2xl text-center`}>
            <CheckCircle2 size={40} className="text-green-400 mx-auto mb-3" />
            <p className="text-white font-semibold">No alerts match the current filters</p>
            <p className="text-genz-muted text-sm mt-1">The Risk Engine is active and monitoring.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {alerts.map(alert => {
              const rs = risk(alert.riskLevel);
              return (
                <div key={alert._id}
                     onClick={() => setSelectedAlert(alert)}
                     className={`flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-lg ${rs.bg}`}
                     style={{ borderColor: rs.border.replace('border-', '') }}>

                  {/* Risk dot */}
                  <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${rs.dot}`} />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`text-xs font-bold ${rs.text}`}>{alert.riskLevel.toUpperCase()}</span>
                      <span className="text-xs text-genz-muted">·</span>
                      <span className="text-xs text-white/80 font-medium">
                        {RISK_TYPE_LABELS[alert.riskType] || alert.riskType}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-genz-muted">
                      <span className="flex items-center gap-1">
                        <User size={10} /> {alert.clientId?.fullName || 'Unknown'}
                      </span>
                      {alert.context?.ipAddress && (
                        <span className="flex items-center gap-1">
                          <Globe size={10} /> {alert.context.ipAddress}
                        </span>
                      )}
                      {alert.context?.toolName && (
                        <span className="flex items-center gap-1">
                          <Zap size={10} /> {alert.context.toolName}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Meta */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLES[alert.status]}`}>
                      {alert.status}
                    </span>
                    <span className="text-xs text-genz-muted">
                      {new Date(alert.createdAt).toLocaleDateString()}
                    </span>
                    <Eye size={14} className="text-genz-muted" />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {total > 25 && (
          <div className="flex justify-center gap-3">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                    className="px-4 py-2 rounded-xl text-sm border border-white/10 text-genz-muted hover:border-white/30 hover:text-white disabled:opacity-30 transition-all">
              ← Prev
            </button>
            <span className="px-4 py-2 text-sm text-genz-muted">
              Page {page} of {Math.ceil(total / 25)}
            </span>
            <button disabled={page * 25 >= total} onClick={() => setPage(p => p + 1)}
                    className="px-4 py-2 rounded-xl text-sm border border-white/10 text-genz-muted hover:border-white/30 hover:text-white disabled:opacity-30 transition-all">
              Next →
            </button>
          </div>
        )}

        {/* Enterprise mode notice */}
        <div className={`${ADMIN_CARD_VARIANTS.default} p-4 rounded-2xl`}>
          <div className="flex items-start gap-3">
            <Info size={16} className="text-genz-teal flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-white text-sm font-semibold mb-1">Enterprise Managed Chrome</p>
              <p className="text-genz-muted text-xs leading-relaxed">
                The most reliable way to prevent unauthorized cookie-access extensions on member devices
                is via Google Admin Console → Chrome → App & Extension Management → Block Extensions by policy.
                Set <code className="text-genz-teal bg-genz-teal/10 px-1 rounded">ExtensionInstallBlocklist: *</code> and
                <code className="text-genz-teal bg-genz-teal/10 px-1 rounded ml-1">ExtensionInstallAllowlist: [gen-z-ext-id]</code>.
                This is optional and only applicable to managed enterprise devices.
              </p>
            </div>
          </div>
        </div>

      </div>

      {/* Alert detail modal */}
      {selectedAlert && (
        <AlertDetailModal
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
          onAction={load}
        />
      )}
    </AdminLayoutEnhanced>
  );
};

export default AdminSecurityAlerts;
