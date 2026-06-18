import { useState, useEffect, useCallback } from 'react';
import {
  Search, Package, User as UserIcon, Edit2, CalendarClock, CalendarX,
  Ban, Trash2, Save, X, Mail, Inbox
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../Toast';

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
  const scope = toolId ? 'tool' : clientId ? 'client' : 'global';

  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [tools, setTools] = useState([]);
  const [clients, setClients] = useState([]);
  const [editing, setEditing] = useState(null);
  const [extending, setExtending] = useState(null);

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

      const res = await api.get(`/admin/assignments?${params}`);
      setAssignments(res.data.assignments || []);
    } catch (e) {
      showError('Failed to load assignments');
    } finally {
      setLoading(false);
    }
  }, [toolId, clientId, toolFilter, clientFilter, statusFilter, search, showError]);

  useEffect(() => { load(); }, [load]);

  // Load tool/client lists for the global-view filter dropdowns.
  useEffect(() => {
    if (!showFilters) return;
    (async () => {
      try {
        const [t, c] = await Promise.all([
          api.get('/admin/tools?limit=100'),
          api.get('/admin/clients?limit=100'),
        ]);
        setTools(t.data.tools || []);
        setClients(c.data.clients || []);
      } catch (_) { /* filters are best-effort */ }
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

  const selectCls = "px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal appearance-none cursor-pointer";

  return (
    <div className="space-y-4">
      {/* Filters */}
      {showFilters && (
        <div className="flex flex-col lg:flex-row lg:items-center gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-genz-muted" size={15} />
            <input
              type="text" value={search} placeholder="Search client or tool…"
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal"
              data-testid="assignment-search"
            />
          </div>
          <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className={selectCls} aria-label="Filter by client" data-testid="assignment-client-filter">
            <option value="">All clients</option>
            {clients.map(c => <option key={c._id} value={c._id}>{c.fullName}</option>)}
          </select>
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
        </div>
      ) : (
        <div className="border border-genz-border rounded-xl overflow-hidden">
          {/* header (desktop) */}
          <div className="hidden md:grid grid-cols-[1.6fr_0.9fr_0.9fr_0.9fr_auto] gap-3 px-4 py-2.5 bg-genz-bg text-[11px] font-semibold uppercase tracking-wide text-genz-muted">
            <span>{scope === 'client' ? 'Tool' : 'Client'}</span>
            <span>Status</span>
            <span>Assigned</span>
            <span>Expiry</span>
            <span className="text-right">Actions</span>
          </div>

          <div className="divide-y divide-genz-border">
            {assignments.map(a => {
              const primary = scope === 'client' ? a.tool : a.client;
              const primaryName = scope === 'client' ? (a.tool?.name || 'Unknown tool') : (a.client?.fullName || 'Unknown client');
              const primarySub = scope === 'client' ? (a.tool?.category || '') : (a.client?.email || '');
              const PrimaryIcon = scope === 'client' ? Package : UserIcon;
              return (
                <div key={a._id}
                  className="grid grid-cols-1 md:grid-cols-[1.6fr_0.9fr_0.9fr_0.9fr_auto] gap-2 md:gap-3 md:items-center px-4 py-3 hover:bg-genz-bg/60 transition-colors"
                  data-testid={`assignment-row-${a._id}`}>
                  {/* primary entity */}
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-white"
                      style={{ background: 'var(--gradient-cta)' }}>
                      <PrimaryIcon size={15} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-genz-navy truncate">{primaryName}</p>
                      {primarySub && (
                        <p className="text-xs text-genz-muted truncate flex items-center gap-1">
                          {scope !== 'client' && <Mail size={10} />}{primarySub}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* status */}
                  <div className="flex md:block items-center gap-2">
                    <StatusBadge status={a.effectiveStatus} />
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
                    <Act tone="blue" icon={Edit2} title="Edit assignment" onClick={() => setEditing(a)} testId={`edit-${a._id}`} />
                    <Act tone="teal" icon={CalendarClock} title="Extend expiry" onClick={() => setExtending(a)} testId={`extend-${a._id}`} />
                    {a.effectiveStatus !== 'expired' && (
                      <Act tone="amber" icon={CalendarX} title="Expire now" onClick={() => expireNow(a)} testId={`expire-${a._id}`} />
                    )}
                    {a.effectiveStatus !== 'revoked' && (
                      <Act tone="amber" icon={Ban} title="Revoke access" onClick={() => revoke(a)} testId={`revoke-${a._id}`} />
                    )}
                    <Act tone="red" icon={Trash2} title="Remove assignment" onClick={() => remove(a)} testId={`remove-${a._id}`} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!loading && assignments.length > 0 && (
        <p className="text-xs text-genz-muted">{assignments.length} assignment{assignments.length === 1 ? '' : 's'}</p>
      )}

      {editing && <EditModal assignment={editing} onClose={() => setEditing(null)} onSaved={() => afterMutation('Assignment updated')} />}
      {extending && <ExtendModal assignment={extending} onClose={() => setExtending(null)} onSaved={() => afterMutation('Expiry extended')} />}
    </div>
  );
};

export default AssignmentManager;
