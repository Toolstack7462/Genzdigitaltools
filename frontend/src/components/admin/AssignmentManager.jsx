import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Package, Edit2, CalendarClock, CalendarX,
  Ban, Trash2, Save, X, Mail, Inbox, Settings, ChevronLeft, ChevronRight, FileText
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../Toast';
import ClientSearchSelect from './ClientSearchSelect';

// Access-mode badge: how the client reaches the tool (kept separate per access mode).
const ACCESS_META = {
  extension: { label: 'Extension', cls: 'bg-blue-500/10 text-blue-600' },
  proxy:     { label: 'Proxy',     cls: 'bg-purple-500/10 text-purple-600' },
  direct:    { label: 'Direct',    cls: 'bg-genz-teal/10 text-genz-teal' },
};
const AccessBadge = ({ mode }) => {
  const meta = ACCESS_META[mode] || ACCESS_META.extension;
  return <span className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded-full ${meta.cls}`}>{meta.label}</span>;
};

// ── helpers ──────────────────────────────────────────────────────────────────
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const toDateInput = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toISOString().split('T')[0];
};

const STATUS_META = {
  active:   { label: 'Active',        cls: 'ds-badge-success' },
  expiring: { label: 'Expiring soon', cls: 'ds-badge-warn' },
  expired:  { label: 'Expired',       cls: 'ds-badge-danger' },
  revoked:  { label: 'Revoked',       cls: 'ds-badge-neutral' },
};

const StatusBadge = ({ status }) => {
  const meta = STATUS_META[status] || STATUS_META.active;
  return <span className={`ds-badge ${meta.cls}`}><span className="dot" /> {meta.label}</span>;
};

const RemainingPill = ({ a }) => {
  if (a.effectiveStatus === 'revoked') return <span className="text-xs text-genz-muted">Revoked</span>;
  if (a.endDate == null) return <span className="text-xs text-genz-muted">No expiry</span>;
  if (a.remainingDays == null) return <span className="text-xs text-genz-muted">—</span>;
  if (a.remainingDays < 0 || a.effectiveStatus === 'expired') {
    return <span className="text-xs font-semibold text-red-500">Expired</span>;
  }
  const tone = a.remainingDays <= 7 ? 'text-amber-600' : 'text-genz-navy';
  return <span className={`text-xs font-semibold ${tone}`}>{a.remainingDays}d left</span>;
};

// ── Edit assignment mini-modal ───────────────────────────────────────────────
const EditModal = ({ assignment, onClose, onSaved }) => {
  const { showError } = useToast();
  const [form, setForm] = useState({
    startDate: toDateInput(assignment.startDate),
    endDate: toDateInput(assignment.endDate),
    status: assignment.status || 'active',
    notes: assignment.notes || '',
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    try {
      setSaving(true);
      await api.put(`/admin/assignments/${assignment._id}`, {
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        status: form.status,
        notes: form.notes,
      });
      onSaved();
    } catch (e) {
      showError(e.response?.data?.error || 'Failed to update assignment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-genz-navy/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white border border-genz-border rounded-2xl shadow-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-genz-navy">Edit Assignment</h3>
          <button onClick={onClose} className="text-genz-muted hover:text-genz-navy" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-genz-navy mb-1">Start date</label>
              <input type="date" value={form.startDate}
                onChange={(e) => setForm(f => ({ ...f, startDate: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal" />
            </div>
            <div>
              <label className="block text-xs font-medium text-genz-navy mb-1">Expiry date</label>
              <input type="date" value={form.endDate} min={form.startDate || undefined}
                onChange={(e) => setForm(f => ({ ...f, endDate: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-genz-navy mb-1">Status</label>
            <select value={form.status}
              onChange={(e) => setForm(f => ({ ...f, status: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal">
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="revoked">Revoked</option>
            </select>
            <p className="text-[11px] text-genz-muted mt-1">Leave expiry blank for unlimited access.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-genz-navy mb-1">Notes</label>
            <textarea rows={2} value={form.notes}
              onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal resize-none" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-sm text-genz-muted hover:text-genz-navy">Cancel</button>
          <button onClick={save} disabled={saving}
            className="btn-grad inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50">
            <Save size={15} /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Extend expiry mini-modal ─────────────────────────────────────────────────
const ExtendModal = ({ assignment, onClose, onSaved }) => {
  const { showError } = useToast();
  const [preset, setPreset] = useState('30');
  const [customDate, setCustomDate] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    try {
      setSaving(true);
      const body = customDate ? { endDate: customDate } : { durationDays: parseInt(preset, 10) };
      await api.post(`/admin/assignments/${assignment._id}/extend`, body);
      onSaved();
    } catch (e) {
      showError(e.response?.data?.error || 'Failed to extend assignment');
    } finally {
      setSaving(false);
    }
  };

  const presets = [['7', '+1 week'], ['30', '+1 month'], ['90', '+3 months'], ['365', '+1 year']];

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-genz-navy/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white border border-genz-border rounded-2xl shadow-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-bold text-genz-navy">Extend Expiry</h3>
          <button onClick={onClose} className="text-genz-muted hover:text-genz-navy" aria-label="Close"><X size={18} /></button>
        </div>
        <p className="text-xs text-genz-muted mb-4">
          Current expiry: <span className="font-medium text-genz-navy">{fmtDate(assignment.endDate)}</span>
        </p>

        <div className="flex flex-wrap gap-2 mb-4">
          {presets.map(([days, label]) => (
            <button key={days} type="button"
              onClick={() => { setPreset(days); setCustomDate(''); }}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                !customDate && preset === days ? 'btn-grad' : 'bg-genz-bg text-genz-muted border border-genz-border hover:border-genz-teal/50'
              }`}>
              {label}
            </button>
          ))}
        </div>

        <div>
          <label className="block text-xs font-medium text-genz-navy mb-1">Or set an exact date</label>
          <input type="date" value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal" />
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-sm text-genz-muted hover:text-genz-navy">Cancel</button>
          <button onClick={save} disabled={saving}
            className="btn-grad inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50">
            <CalendarClock size={15} /> {saving ? 'Extending…' : 'Extend'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Bulk "extend expiry" modal — applies one new expiry to every selected row ──
const BulkExtendModal = ({ count, onClose, onApply }) => {
  const [preset, setPreset] = useState('30');
  const [customDate, setCustomDate] = useState('');
  const presets = [['7', '+1 week'], ['30', '+1 month'], ['90', '+3 months'], ['365', '+1 year']];
  const apply = () => {
    if (customDate) onApply({ endDate: customDate });
    else onApply({ durationDays: parseInt(preset, 10) });
  };
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-genz-navy/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white border border-genz-border rounded-2xl shadow-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-bold text-genz-navy">Extend {count} assignment{count === 1 ? '' : 's'}</h3>
          <button onClick={onClose} className="text-genz-muted hover:text-genz-navy" aria-label="Close"><X size={18} /></button>
        </div>
        <p className="text-xs text-genz-muted mb-4">Each selected assignment's expiry extends from its current expiry (or today if already past).</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {presets.map(([days, label]) => (
            <button key={days} type="button" onClick={() => { setPreset(days); setCustomDate(''); }}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${!customDate && preset === days ? 'btn-grad' : 'bg-genz-bg text-genz-muted border border-genz-border hover:border-genz-teal/50'}`}>
              {label}
            </button>
          ))}
        </div>
        <div>
          <label className="block text-xs font-medium text-genz-navy mb-1">Or set an exact date</label>
          <input type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal" />
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-sm text-genz-muted hover:text-genz-navy">Cancel</button>
          <button onClick={apply} className="btn-grad inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold">
            <CalendarClock size={15} /> Extend
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Action icon button ───────────────────────────────────────────────────────
const Act = ({ onClick, title, tone, icon: Icon, testId }) => {
  const tones = {
    blue:  'text-genz-blue hover:bg-genz-blue/10',
    teal:  'text-genz-teal hover:bg-genz-teal/10',
    amber: 'text-amber-500 hover:bg-amber-500/10',
    red:   'text-red-500 hover:bg-red-500/10',
  };
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} data-testid={testId}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border border-genz-border bg-genz-bg ${tones[tone]} transition-colors`}>
      <Icon size={14} />
    </button>
  );
};

/**
 * AssignmentManager — lists tool↔client assignments and manages them.
 *
 * Scope:
 *   - toolId set   → assignments for one tool (shows the CLIENT per row)
 *   - clientId set → assignments for one client (shows the TOOL per row)
 *   - neither + showFilters → central view of all assignments
 */
const AssignmentManager = ({ toolId, clientId, showFilters = false, onChanged }) => {
  const { showSuccess, showError } = useToast();
  const navigate = useNavigate();
  const scope = toolId ? 'tool' : clientId ? 'client' : 'global';

  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [accessFilter, setAccessFilter] = useState('');   // extension | proxy | direct
  const [expiryFilter, setExpiryFilter] = useState('');    // '7' | '30' | '90' (expiring within N days)
  const [tools, setTools] = useState([]);
  const [clients, setClients] = useState([]);
  const [listsLoading, setListsLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [extending, setExtending] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 50;
  // Phase 2: bulk multi-select (read-only proxy/stealth rows are excluded — they have
  // no assignment-CRUD endpoints and are managed on their own pages).
  const [selected, setSelected] = useState(() => new Set());
  const [bulkExtendOpen, setBulkExtendOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (toolId) params.append('toolId', toolId);
      else if (toolFilter) params.append('toolId', toolFilter);
      if (clientId) params.append('clientId', clientId);
      else if (clientFilter) params.append('clientId', clientFilter);
      if (statusFilter) params.append('status', statusFilter);
      if (search.trim()) params.append('search', search.trim());
      if (accessFilter) params.append('accessMode', accessFilter);
      if (expiryFilter) params.append('expiringInDays', expiryFilter);
      params.append('page', String(page));
      params.append('limit', String(PAGE_SIZE));

      const res = await api.get(`/admin/assignments?${params}`);
      setAssignments(res.data.assignments || []);
      setTotal(res.data.total || 0);
      setSelected(new Set()); // clear stale selection on any (re)load
    } catch (e) {
      // Actionable, secret-free message: include the HTTP status so a missing
      // backend route (404) is distinguishable from a real server error (500) or
      // a network failure. The endpoint path is logged safely by the api client.
      const status = e.response?.status;
      const serverMsg = e.response?.data?.error;
      showError(
        status === 404
          ? 'Failed to load assignments — the assignments API route is unavailable (404). The backend may need to be redeployed.'
          : status
            ? `Failed to load assignments (HTTP ${status})${serverMsg ? ` — ${serverMsg}` : ''}`
            : 'Failed to load assignments — could not reach the server.'
      );
    } finally {
      setLoading(false);
    }
  }, [toolId, clientId, toolFilter, clientFilter, statusFilter, search, accessFilter, expiryFilter, page, showError]);

  useEffect(() => { load(); }, [load]);

  // Reset to page 1 whenever a filter/search changes so results aren't on a stale page.
  useEffect(() => { setPage(1); }, [toolId, clientId, toolFilter, clientFilter, statusFilter, search, accessFilter, expiryFilter]);

  // Load tool/client lists for the global-view filter dropdowns.
  useEffect(() => {
    if (!showFilters) return;
    (async () => {
      try {
        setListsLoading(true);
        const [t, c] = await Promise.all([
          api.get('/admin/tools?limit=100'),
          api.get('/admin/clients?limit=100'),
        ]);
        setTools(t.data.tools || []);
        setClients(c.data.clients || []);
      } catch (_) { /* filters are best-effort */ }
      finally { setListsLoading(false); }
    })();
  }, [showFilters]);

  const afterMutation = (msg) => {
    if (msg) showSuccess(msg);
    setEditing(null);
    setExtending(null);
    load();
    onChanged?.();
  };

  const expireNow = async (a) => {
    if (!window.confirm('Expire this assignment now? The client will immediately lose access.')) return;
    try {
      await api.post(`/admin/assignments/${a._id}/expire`);
      afterMutation('Assignment expired');
    } catch (e) { showError(e.response?.data?.error || 'Failed to expire assignment'); }
  };

  const revoke = async (a) => {
    if (!window.confirm('Revoke this assignment? Access is removed but the record is kept for audit.')) return;
    try {
      await api.post(`/admin/assignments/${a._id}/revoke`);
      afterMutation('Assignment revoked');
    } catch (e) { showError(e.response?.data?.error || 'Failed to revoke assignment'); }
  };

  const remove = async (a) => {
    const who = a.client?.fullName || a.tool?.name || 'this assignment';
    if (!window.confirm(`Remove ${who}? This permanently deletes the assignment.`)) return;
    try {
      await api.delete(`/admin/assignments/${a._id}`);
      afterMutation('Assignment removed');
    } catch (e) { showError(e.response?.data?.error || 'Failed to remove assignment'); }
  };

  // ── Bulk selection helpers ───────────────────────────────────────────────────
  const selectableIds = assignments.filter(a => !a.readOnly).map(a => a._id);
  const allPageSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));
  const toggleSelect = (id) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const toggleSelectAll = () => setSelected(prev => {
    if (selectableIds.length && selectableIds.every(id => prev.has(id))) {
      const n = new Set(prev); selectableIds.forEach(id => n.delete(id)); return n;
    }
    return new Set([...prev, ...selectableIds]);
  });
  const clearSelection = () => setSelected(new Set());

  // Apply a per-id endpoint across all selected rows; report combined result. Reuses
  // the existing single-assignment endpoints (no new backend) via allSettled so one
  // failure doesn't abort the batch. afterMutation reloads + clears the selection.
  const runBulk = async (fn, verb) => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(ids.map(fn));
    setBulkBusy(false);
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    if (ok) afterMutation(`${verb} ${ok} assignment${ok === 1 ? '' : 's'}${failed ? ` — ${failed} failed` : ''}`);
    else showError(`Bulk action failed for all ${ids.length} assignment${ids.length === 1 ? '' : 's'}`);
  };
  const bulkRevoke = () => { if (!window.confirm(`Revoke ${selected.size} assignment(s)? Clients lose access immediately.`)) return; runBulk(id => api.post(`/admin/assignments/${id}/revoke`), 'Revoked'); };
  const bulkExpire = () => { if (!window.confirm(`Expire ${selected.size} assignment(s) now?`)) return; runBulk(id => api.post(`/admin/assignments/${id}/expire`), 'Expired'); };
  const bulkDelete = () => { if (!window.confirm(`Permanently delete ${selected.size} assignment(s)? This cannot be undone.`)) return; runBulk(id => api.delete(`/admin/assignments/${id}`), 'Removed'); };
  const bulkExtendApply = (payload) => { setBulkExtendOpen(false); runBulk(id => api.post(`/admin/assignments/${id}/extend`, payload), 'Extended'); };

  const selectCls = "px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal appearance-none cursor-pointer";

  return (
    <div className="space-y-4">
      {/* Filters */}
      {showFilters && (
        <div className="flex flex-col md:flex-row md:flex-wrap md:items-center gap-2.5">
          <div className="relative flex-1 min-w-0 md:min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={15} />
            <input
              type="text" value={search} placeholder="Search client or tool…"
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal"
              data-testid="assignment-search"
            />
          </div>
          <div className="w-full md:w-52 lg:w-60" data-testid="assignment-client-filter">
            <ClientSearchSelect
              id="assignment-client-filter"
              clients={clients}
              value={clientFilter}
              onChange={(id) => setClientFilter(id)}
              loading={listsLoading}
              placeholder="All clients"
              ariaLabel="Filter by client"
              className="bg-genz-bg border-genz-border text-genz-navy focus:border-genz-teal"
            />
          </div>
          <select value={toolFilter} onChange={(e) => setToolFilter(e.target.value)} className={selectCls} aria-label="Filter by tool" data-testid="assignment-tool-filter">
            <option value="">All tools</option>
            {tools.map(t => <option key={t._id} value={t._id}>{t.name}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls} aria-label="Filter by status" data-testid="assignment-status-filter">
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="expiring">Expiring soon</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>
          <select value={accessFilter} onChange={(e) => setAccessFilter(e.target.value)} className={selectCls} aria-label="Filter by access mode" data-testid="assignment-access-filter">
            <option value="">All access</option>
            <option value="extension">Extension</option>
            <option value="proxy">Proxy</option>
            <option value="direct">Direct</option>
          </select>
          <select value={expiryFilter} onChange={(e) => setExpiryFilter(e.target.value)} className={selectCls} aria-label="Filter by expiry window" data-testid="assignment-expiry-filter">
            <option value="">Any expiry</option>
            <option value="7">Expiring ≤ 7 days</option>
            <option value="30">Expiring ≤ 30 days</option>
            <option value="90">Expiring ≤ 90 days</option>
          </select>
        </div>
      )}

      {/* Status filter for scoped (modal) views — compact pills */}
      {!showFilters && (
        <div className="flex flex-wrap items-center gap-1.5">
          {['', 'active', 'expiring', 'expired', 'revoked'].map(s => (
            <button key={s || 'all'} type="button" onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                statusFilter === s ? 'bg-genz-teal/15 text-genz-teal border border-genz-teal/40' : 'bg-genz-bg text-genz-muted border border-genz-border hover:border-genz-teal/40'
              }`}>
              {s === '' ? 'All' : STATUS_META[s].label}
            </button>
          ))}
        </div>
      )}

      {/* Bulk action bar (appears when rows are selected) */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-genz-teal/10 border border-genz-teal/30" data-testid="bulk-action-bar">
          <span className="text-sm font-semibold text-genz-navy">{selected.size} selected</span>
          <div className="flex flex-wrap items-center gap-1.5 ml-auto">
            <button type="button" disabled={bulkBusy} onClick={() => setBulkExtendOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-genz-border bg-white text-genz-teal hover:bg-genz-teal/10 text-xs font-semibold disabled:opacity-50">
              <CalendarClock size={13} /> Extend
            </button>
            <button type="button" disabled={bulkBusy} onClick={bulkExpire}
              className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-genz-border bg-white text-amber-600 hover:bg-amber-500/10 text-xs font-semibold disabled:opacity-50">
              <CalendarX size={13} /> Expire
            </button>
            <button type="button" disabled={bulkBusy} onClick={bulkRevoke}
              className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-genz-border bg-white text-amber-600 hover:bg-amber-500/10 text-xs font-semibold disabled:opacity-50">
              <Ban size={13} /> Revoke
            </button>
            <button type="button" disabled={bulkBusy} onClick={bulkDelete}
              className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-genz-border bg-white text-red-500 hover:bg-red-500/10 text-xs font-semibold disabled:opacity-50">
              <Trash2 size={13} /> Delete
            </button>
            <button type="button" disabled={bulkBusy} onClick={clearSelection}
              className="inline-flex items-center px-2.5 h-8 rounded-lg text-xs font-medium text-genz-muted hover:text-genz-navy disabled:opacity-50">
              Clear
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 rounded-xl bg-genz-bg animate-pulse" />
          ))}
        </div>
      ) : assignments.length === 0 ? (
        <div className="text-center py-10">
          <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-genz-bg flex items-center justify-center">
            <Inbox size={26} className="text-genz-muted" />
          </div>
          <p className="text-sm font-semibold text-genz-navy">No assignments found</p>
          <p className="text-xs text-genz-muted mt-0.5">
            {scope === 'tool' ? 'No clients have this tool assigned yet.'
              : scope === 'client' ? 'This client has no tools assigned yet.'
              : 'Try adjusting your filters.'}
          </p>
          {scope === 'client' && clientId && (
            <button
              type="button"
              onClick={() => navigate(`/admin/clients/${clientId}/assign`)}
              className="btn-grad inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold mt-4"
            >
              <Package size={15} /> Assign tools
            </button>
          )}
        </div>
      ) : (
        <div className="border border-genz-border rounded-xl overflow-hidden">
          {/* header (desktop) */}
          <div className="hidden md:grid grid-cols-[1.6fr_0.9fr_0.9fr_0.9fr_auto] gap-3 px-4 py-2.5 bg-genz-bg text-[11px] font-semibold uppercase tracking-wide text-genz-muted">
            <span className="flex items-center gap-2">
              {selectableIds.length > 0 && (
                <input type="checkbox" checked={allPageSelected} onChange={toggleSelectAll}
                  className="w-4 h-4 accent-genz-teal cursor-pointer" aria-label="Select all on this page" data-testid="bulk-select-all" />
              )}
              {scope === 'client' ? 'Tool' : 'Client'}
            </span>
            <span>Status</span>
            <span>Assigned</span>
            <span>Expiry</span>
            <span className="text-right">Actions</span>
          </div>

          <div className="divide-y divide-genz-border">
            {assignments.map(a => {
              const isToolPrimary = scope === 'client';
              const primaryName = isToolPrimary ? (a.tool?.name || 'Unknown tool') : (a.client?.fullName || 'Unknown client');
              const primarySub = isToolPrimary ? (a.tool?.category || '') : (a.client?.email || '');
              return (
                <div key={a._id}
                  className="grid grid-cols-1 md:grid-cols-[1.6fr_0.9fr_0.9fr_0.9fr_auto] gap-2 md:gap-3 md:items-center px-4 py-3 hover:bg-genz-bg/60 transition-colors"
                  data-testid={`assignment-row-${a._id}`}>
                  {/* primary entity */}
                  <div className="flex items-center gap-2.5 min-w-0">
                    {a.readOnly ? (
                      <span className="w-4 flex-shrink-0" aria-hidden="true" />
                    ) : (
                      <input type="checkbox" checked={selected.has(a._id)} onChange={() => toggleSelect(a._id)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-4 h-4 accent-genz-teal flex-shrink-0 cursor-pointer" aria-label="Select assignment" />
                    )}
                    {isToolPrimary ? (
                      // Tool row (per-client view): tool glyph.
                      <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-white"
                        style={{ background: 'var(--gradient-cta)' }}>
                        <Package size={16} />
                      </span>
                    ) : (
                      // Client row (per-tool / global view): initials avatar, matching the
                      // Members page so the client reads consistently across the admin.
                      <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-white text-sm font-bold"
                        style={{ background: 'var(--gradient-cta)' }}>
                        {(a.client?.fullName || '?').charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-genz-navy truncate">{primaryName}</p>
                      {primarySub ? (
                        <p className="text-xs text-genz-muted truncate flex items-center gap-1">
                          {!isToolPrimary && <Mail size={10} className="flex-shrink-0" />}{primarySub}
                        </p>
                      ) : (
                        !isToolPrimary && <p className="text-xs text-genz-muted/70 italic truncate">No email on file</p>
                      )}
                      {a.notes ? (
                        <p className="text-[11px] text-genz-muted/80 truncate flex items-center gap-1 mt-0.5" title={a.notes}>
                          <FileText size={10} className="flex-shrink-0" />{a.notes}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {/* status + access mode */}
                  <div className="flex md:block items-center gap-2">
                    <StatusBadge status={a.effectiveStatus} />
                    <div className="mt-1"><AccessBadge mode={a.accessMode} /></div>
                  </div>

                  {/* assigned date */}
                  <div className="text-xs text-genz-muted">
                    <span className="md:hidden font-medium text-genz-navy mr-1">Assigned:</span>{fmtDate(a.assignedAt)}
                  </div>

                  {/* expiry + remaining */}
                  <div className="text-xs">
                    <span className="md:hidden font-medium text-genz-navy mr-1">Expiry:</span>
                    <span className="text-genz-muted">{a.endDate ? fmtDate(a.endDate) : 'No expiry'}</span>
                    <div className="mt-0.5"><RemainingPill a={a} /></div>
                  </div>

                  {/* actions */}
                  <div className="flex items-center justify-start md:justify-end gap-1.5 pt-1 md:pt-0">
                    {a.readOnly ? (
                      // Proxy / StealthWriter tools are managed on their dedicated admin
                      // page (separate lease/gateway flow — never the assignment CRUD).
                      <button type="button"
                        onClick={() => navigate(a.manageUrl || '/admin/proxy-tools')}
                        title="Manage on its tool page"
                        className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-genz-border bg-genz-bg text-genz-teal hover:bg-genz-teal/10 transition-colors text-xs font-semibold"
                        data-testid={`manage-${a._id}`}>
                        <Settings size={13} /> Manage
                      </button>
                    ) : (
                      <>
                        <Act tone="blue" icon={Edit2} title="Edit assignment" onClick={() => setEditing(a)} testId={`edit-${a._id}`} />
                        <Act tone="teal" icon={CalendarClock} title="Extend expiry" onClick={() => setExtending(a)} testId={`extend-${a._id}`} />
                        {a.effectiveStatus !== 'expired' && (
                          <Act tone="amber" icon={CalendarX} title="Expire now" onClick={() => expireNow(a)} testId={`expire-${a._id}`} />
                        )}
                        {a.effectiveStatus !== 'revoked' && (
                          <Act tone="amber" icon={Ban} title="Revoke access" onClick={() => revoke(a)} testId={`revoke-${a._id}`} />
                        )}
                        <Act tone="red" icon={Trash2} title="Remove assignment" onClick={() => remove(a)} testId={`remove-${a._id}`} />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!loading && total > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-genz-muted">{total} assignment{total === 1 ? '' : 's'}</p>
          {total > PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="p-1.5 rounded-lg border border-genz-border text-genz-muted hover:text-genz-navy disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page">
                <ChevronLeft size={16} />
              </button>
              <span className="text-xs text-genz-muted">Page {page} of {Math.ceil(total / PAGE_SIZE)}</span>
              <button type="button" onClick={() => setPage(p => (p < Math.ceil(total / PAGE_SIZE) ? p + 1 : p))} disabled={page >= Math.ceil(total / PAGE_SIZE)}
                className="p-1.5 rounded-lg border border-genz-border text-genz-muted hover:text-genz-navy disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page">
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
      )}

      {editing && <EditModal assignment={editing} onClose={() => setEditing(null)} onSaved={() => afterMutation('Assignment updated')} />}
      {extending && <ExtendModal assignment={extending} onClose={() => setExtending(null)} onSaved={() => afterMutation('Expiry extended')} />}
      {bulkExtendOpen && <BulkExtendModal count={selected.size} onClose={() => setBulkExtendOpen(false)} onApply={bulkExtendApply} />}
    </div>
  );
};

export default AssignmentManager;
