import { useState, useEffect, useCallback, useMemo } from 'react';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import {
  CalendarClock, RefreshCw, Mail, MessageCircle, AlertTriangle, Clock,
  Loader2, CheckCircle2, Plus, MailWarning, Search, X,
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import { buildRenewalMessage } from '../../components/admin/whatsappTemplates';
import WhatsAppSendDialog from '../../components/admin/WhatsAppSendDialog';

const WINDOWS = [
  { key: 7, label: '7 days' },
  { key: 14, label: '14 days' },
  { key: 30, label: '30 days' },
];

// Status filters (client-side over the already-fetched window). Distinct from the
// day-window filter above — no overlap/duplication.
const STATUSES = [
  { key: 'all', label: 'All' },
  { key: 'expiring', label: 'Expiring' },
  { key: 'expired', label: 'Expired' },
  { key: 'reminded', label: 'Reminded' },
  { key: 'notReminded', label: 'Not reminded' },
];

const fmtAgo = (d) => {
  if (!d) return '';
  const dt = new Date(d); if (isNaN(dt.getTime())) return '';
  const days = Math.floor((Date.now() - dt.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const toolLabel = (t) => (t.expired ? 'Expired' : (t.daysLeft === 0 ? 'Today' : `${t.daysLeft}d`));
const toolCls = (t) => t.expired
  ? 'bg-red-50 text-red-700 border-red-200'
  : (t.daysLeft <= 3 ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-cyan-50 text-cyan-700 border-cyan-200');

const AdminRenewals = () => {
  const { showSuccess, showError, showWarning, showInfo } = useToast();
  const [days, setDays] = useState(14);
  const [data, setData] = useState({ clients: [], counts: {}, emailEnabled: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState({}); // clientId|assignmentId -> true
  const [waClient, setWaClient] = useState(null); // client for the WhatsApp dialog
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Debounce the search box so typing stays snappy (filtering is client-side).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async (d = days) => {
    try {
      setLoading(true); setError(false);
      const res = await api.get(`/admin/renewals?days=${d}`);
      setData({
        clients: res.data?.clients || [],
        counts: res.data?.counts || {},
        emailEnabled: res.data?.emailEnabled !== false,
      });
    } catch (_) { setError(true); }
    finally { setLoading(false); }
  }, [days]);

  useEffect(() => { load(); }, [load]); // load is keyed on `days`, so this re-runs on window change

  const setBusyFor = (id, v) => setBusy(b => { const c = { ...b }; if (v) c[id] = true; else delete c[id]; return c; });

  const sendEmail = async (c) => {
    setBusyFor(c.clientId, true);
    try {
      const res = await api.post(`/admin/renewals/${c.clientId}/remind`, { channel: 'email', days });
      if (res.data?.success) showSuccess(`Renewal email sent to ${c.fullName || c.email}`);
      else if (res.data?.emailEnabled === false) showWarning('Email is not configured on the server. Use WhatsApp instead.');
      else showError(res.data?.error || 'Could not send the email.');
      load(days);
    } catch (e) { showError(e.response?.data?.error || 'Could not send the email.'); }
    finally { setBusyFor(c.clientId, false); }
  };

  // Open the dialog so the admin can confirm/override the number + review the
  // professional message before WhatsApp opens.
  const sendWhatsApp = (c) => setWaClient(c);

  // Fired once WhatsApp has actually been opened from the dialog: record the touch
  // (best-effort) so "last reminded" updates.
  const onWhatsAppOpened = (c) => {
    api.post(`/admin/renewals/${c.clientId}/remind`, { channel: 'whatsapp', days })
      .then(() => { showInfo('WhatsApp opened — marked as reminded.'); load(days); })
      .catch(() => {});
  };

  // Save/update the number on the client's profile (reuses the existing client
  // update endpoint). Only runs when the admin ticks "save" in the dialog.
  const saveClientNumber = (c, number) => {
    if (!c) return;
    api.put(`/admin/clients/${c.clientId}`, { phone: number })
      .then(() => { showSuccess('Number saved to client profile'); load(days); })
      .catch((e) => showError(e.response?.data?.error || 'Could not save the number'));
  };

  const quickRenew = async (c, tool) => {
    setBusyFor(tool.assignmentId, true);
    try {
      await api.post(`/admin/assignments/${tool.assignmentId}/extend`, { durationDays: 30 });
      showSuccess(`${tool.toolName} renewed +30 days for ${c.fullName || c.email}`);
      load(days);
    } catch (e) { showError(e.response?.data?.error || 'Could not renew this tool.'); }
    finally { setBusyFor(tool.assignmentId, false); }
  };

  const counts = data.counts || {};

  // Client-side search + status filtering over the fetched window. Search matches
  // client name, email, saved number (digits), and any tool name. Fast + debounced.
  const visibleClients = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return (data.clients || []).filter(c => {
      if (statusFilter === 'expiring' && !(c.expiringCount > 0)) return false;
      if (statusFilter === 'expired' && !(c.expiredCount > 0)) return false;
      if (statusFilter === 'reminded' && !c.lastReminder?.at) return false;
      if (statusFilter === 'notReminded' && c.lastReminder?.at) return false;
      if (!q) return true;
      const hay = [c.fullName, c.email, ...(c.tools || []).map(t => t.toolName)]
        .filter(Boolean).join(' ').toLowerCase();
      const phoneHit = qDigits && String(c.phone || '').includes(qDigits);
      return hay.includes(q) || phoneHit;
    });
  }, [data.clients, debouncedSearch, statusFilter]);

  const filtersActive = !!debouncedSearch.trim() || statusFilter !== 'all';
  const clearFilters = () => { setSearch(''); setStatusFilter('all'); };

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-5xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-extrabold text-genz-navy flex items-center gap-2.5">
              <span className="ds-icon-grad w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"><CalendarClock size={18} /></span>
              Renewals
            </h1>
            <p className="text-sm text-genz-muted mt-0.5">Clients with tools expiring soon or already expired. Remind by email or WhatsApp, or renew in one click.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <div className="inline-flex rounded-xl border border-genz-border overflow-hidden">
              {WINDOWS.map(w => (
                <button key={w.key} onClick={() => setDays(w.key)}
                  className={`px-3 py-2 text-sm font-semibold transition-colors ${days === w.key ? 'bg-genz-teal/10 text-genz-teal' : 'bg-white text-genz-muted hover:text-genz-navy'}`}>
                  {w.label}
                </button>
              ))}
            </div>
            <button onClick={() => load(days)} title="Refresh"
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-genz-border bg-white text-genz-navy text-sm font-medium hover:border-genz-teal/50 transition-colors">
              <RefreshCw size={15} /> Refresh
            </button>
          </div>
        </div>

        {/* Search + status filters */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" />
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, number, or tool…"
              aria-label="Search renewals"
              className="w-full pl-9 pr-9 py-2 text-sm rounded-xl bg-white border border-genz-border text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all"
            />
            {search && (
              <button onClick={() => setSearch('')} aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-genz-muted hover:text-genz-navy"><X size={15} /></button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {STATUSES.map(s => (
              <button key={s.key} onClick={() => setStatusFilter(s.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  statusFilter === s.key ? 'bg-genz-teal/10 text-genz-teal border-genz-teal/30' : 'bg-white text-genz-muted border-genz-border hover:text-genz-navy hover:border-genz-teal/40'
                }`}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Summary chips */}
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-genz-bg text-genz-navy border border-genz-border">
            {counts.clients || 0} client{(counts.clients || 0) === 1 ? '' : 's'}
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-cyan-50 text-cyan-700 border border-cyan-200">
            <Clock size={14} /> {counts.expiring || 0} expiring
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-red-50 text-red-700 border border-red-200">
            <AlertTriangle size={14} /> {counts.expired || 0} expired
          </span>
          {!data.emailEnabled && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold bg-amber-50 text-amber-700 border border-amber-200" title="RESEND_API_KEY / EMAIL_FROM not set on the server">
              <MailWarning size={14} /> Email disabled — use WhatsApp
            </span>
          )}
        </div>

        {/* List */}
        {loading ? (
          <div className="space-y-2.5" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-genz-navy/5 animate-pulse" />)}
          </div>
        ) : error ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-10 text-center`}>
            <AlertTriangle size={26} className="mx-auto mb-2 text-genz-muted" />
            <p className="text-sm font-semibold text-genz-navy">Couldn't load renewals</p>
            <button onClick={() => load(days)} className="text-xs text-genz-teal hover:underline mt-1.5">Try again</button>
          </div>
        ) : data.clients.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-12 text-center`}>
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-green-500/15 to-cyan-500/15 flex items-center justify-center">
              <CheckCircle2 size={30} className="text-green-600" />
            </div>
            <h3 className="text-lg font-bold text-genz-navy mb-1">All clear</h3>
            <p className="text-sm text-genz-muted">No tools are expiring within {days} days. Try a wider window above.</p>
          </div>
        ) : visibleClients.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-12 text-center`}>
            <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-genz-bg flex items-center justify-center">
              <Search size={26} className="text-genz-muted" />
            </div>
            <h3 className="text-base font-bold text-genz-navy mb-1">No matching clients</h3>
            <p className="text-sm text-genz-muted">Nothing matches your search or filters in this window.</p>
            <button onClick={clearFilters} className="mt-3 text-sm font-semibold text-genz-teal hover:underline">Clear filters</button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filtersActive && (
              <div className="flex items-center justify-between gap-2 px-0.5">
                <p className="text-xs text-genz-muted">Showing {visibleClients.length} of {data.clients.length}</p>
                <button onClick={clearFilters} className="text-xs font-semibold text-genz-teal hover:underline">Clear filters</button>
              </div>
            )}
            {visibleClients.map(c => (
              <div key={c.clientId} className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/* Client + tools */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-genz-navy truncate">{c.fullName || 'Unnamed client'}</p>
                      {c.expiredCount > 0 && <span className="ds-badge ds-badge-danger !text-[10px]">{c.expiredCount} expired</span>}
                      {c.expiringCount > 0 && <span className="ds-badge ds-badge-warn !text-[10px]">{c.expiringCount} expiring</span>}
                      {c.status === 'disabled' && <span className="ds-badge ds-badge-neutral !text-[10px]">disabled</span>}
                    </div>
                    <p className="text-xs text-genz-muted mt-0.5 truncate">
                      {c.email || 'no email on file'}
                      {c.phone && <span className="ml-2 inline-flex items-center gap-1 text-emerald-600"><MessageCircle size={11} /> +{c.phone}</span>}
                    </p>
                    {/* Tool chips with quick renew */}
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      {c.tools.map(t => (
                        <span key={t.assignmentId} className={`group inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full text-xs font-medium border max-w-full ${toolCls(t)}`}>
                          <span className="truncate max-w-[160px]">{t.toolName}</span>
                          <span className="opacity-70 flex-shrink-0">· {toolLabel(t)}</span>
                          <button onClick={() => quickRenew(c, t)} disabled={!!busy[t.assignmentId]}
                            title="Renew +30 days"
                            className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/70 hover:bg-white text-genz-blue disabled:opacity-50">
                            {busy[t.assignmentId] ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                          </button>
                        </span>
                      ))}
                    </div>
                    {c.lastReminder?.at && (
                      <p className="text-[11px] text-genz-muted/80 mt-2">
                        Last reminded {fmtAgo(c.lastReminder.at)}{c.lastReminder.channel ? ` · ${c.lastReminder.channel}` : ''}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col items-stretch gap-2 flex-shrink-0">
                    <button onClick={() => sendEmail(c)} disabled={!data.emailEnabled || !c.email || !!busy[c.clientId]}
                      title={!data.emailEnabled ? 'Email is not configured on the server' : (!c.email ? 'No email on file' : 'Send renewal email')}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-bold text-white btn-grad disabled:opacity-50 disabled:cursor-not-allowed">
                      {busy[c.clientId] ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} Email
                    </button>
                    <button onClick={() => sendWhatsApp(c)}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 transition-colors">
                      <MessageCircle size={14} /> WhatsApp
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <WhatsAppSendDialog
        open={!!waClient}
        client={waClient || {}}
        message={waClient ? buildRenewalMessage({ clientName: waClient.fullName, tools: waClient.tools }) : ''}
        canSave
        onSaveNumber={(num) => saveClientNumber(waClient, num)}
        onClose={() => setWaClient(null)}
        onConfirm={() => waClient && onWhatsAppOpened(waClient)}
      />
    </AdminLayoutEnhanced>
  );
};

export default AdminRenewals;
