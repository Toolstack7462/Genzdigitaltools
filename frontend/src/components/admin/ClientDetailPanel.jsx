import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Clock, LogIn, ShieldAlert, ShieldOff, Smartphone, Package, Trash2, Edit2,
  CheckCircle2, AlertCircle, FileText, Activity as ActivityIcon, Loader2, Pencil,
  Tag, MessageCircle, Plus, Check, ChevronDown, Bell,
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../Toast';
import { TagEditor, TagChip } from './ClientTags';
import { WA_TEMPLATES, fillTemplate, buildWhatsAppUrl } from './whatsappTemplates';

/**
 * ClientDetailPanel — client profile hub for ONE client (shown in the per-client
 * modal's "Profile & Timeline" tab). Reuses GET /admin/clients/:id (client,
 * assignments, deviceBinding, activityLogs, extensionScan). Adds: health summary,
 * CRM tags (inline edit), WhatsApp quick-send (manual), follow-up reminders, notes,
 * and the activity timeline. Never renders secrets.
 */
const fmt = (d, withTime = true) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleString(undefined, withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
};

function describe(a) {
  const action = String(a.action || '').toUpperCase();
  const meta = a.meta || {};
  if (action.includes('LOGIN') && action.includes('FAIL')) return { Icon: ShieldAlert, tone: 'text-red-500', text: 'Login failed' + (meta.reason ? ` — ${meta.reason}` : '') };
  if (action.includes('LOGIN') && action.includes('BLOCK')) return { Icon: ShieldOff, tone: 'text-amber-500', text: 'Login blocked (device)' };
  if (action.includes('LOGIN')) return { Icon: LogIn, tone: 'text-green-500', text: 'Signed in' };
  if (action.includes('DEVICE_RESET')) return { Icon: Smartphone, tone: 'text-cyan-500', text: 'Device reset' };
  if (action.includes('TOOL_OPEN') || action.includes('TOOL_ACCESS') || action.includes('LEASE')) return { Icon: Package, tone: 'text-purple-500', text: `Opened ${meta.toolName || meta.tool || 'a tool'}` };
  if (action.includes('ASSIGN')) return { Icon: CheckCircle2, tone: 'text-green-500', text: `Tool assigned${meta.toolName ? `: ${meta.toolName}` : ''}` };
  if (action.includes('REVOKE')) return { Icon: AlertCircle, tone: 'text-amber-500', text: 'Access revoked' };
  if (action.includes('DELETE')) return { Icon: Trash2, tone: 'text-red-500', text: 'Deleted' };
  if (action.includes('UPDATE') || action.includes('EDIT')) return { Icon: Edit2, tone: 'text-yellow-500', text: 'Account updated' };
  return { Icon: ActivityIcon, tone: 'text-genz-muted', text: action.replace(/_/g, ' ').toLowerCase() };
}

const Stat = ({ label, value, tone }) => (
  <div className="bg-genz-bg border border-genz-border rounded-xl px-3 py-2">
    <p className="text-[11px] uppercase tracking-wide text-genz-muted">{label}</p>
    <p className={`text-sm font-semibold truncate ${tone || 'text-genz-navy'}`}>{value}</p>
  </div>
);

// Compute active / expired / expiring(≤7d) from raw assignment rows.
function computeHealth(assignments) {
  const now = Date.now();
  let active = 0, expired = 0, expiring = 0;
  (assignments || []).forEach((a) => {
    if (a.status === 'revoked') return;
    const end = a.endDate ? new Date(a.endDate).getTime() : null;
    if (a.status === 'expired' || (end !== null && end < now)) { expired++; return; }
    active++;
    if (end !== null && end - now <= 7 * 86400000) expiring++;
  });
  return { active, expired, expiring };
}

// Nearest upcoming expiry (for WhatsApp expiry placeholder + tool name).
function nearestExpiry(assignments) {
  const now = Date.now();
  let best = null;
  (assignments || []).forEach((a) => {
    if (a.status === 'revoked' || a.status === 'expired' || !a.endDate) return;
    const t = new Date(a.endDate).getTime();
    if (t >= now && (!best || t < best.t)) best = { t, date: a.endDate, tool: a.toolId?.name || a.tool?.name };
  });
  return best;
}

export default function ClientDetailPanel({ clientId, onEdit }) {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // tags inline edit
  const [tags, setTags] = useState([]);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [savingTags, setSavingTags] = useState(false);

  // whatsapp dropdown
  const [waOpen, setWaOpen] = useState(false);

  // reminders
  const [reminders, setReminders] = useState([]);
  const [remLoading, setRemLoading] = useState(true);
  const [remTitle, setRemTitle] = useState('');
  const [remDue, setRemDue] = useState('');
  const [remBusy, setRemBusy] = useState(false);

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      setLoading(true); setError(false);
      const res = await api.get(`/admin/clients/${clientId}`);
      setData(res.data);
      setTags(Array.isArray(res.data?.client?.tags) ? res.data.client.tags : []);
    } catch (_) { setError(true); }
    finally { setLoading(false); }
  }, [clientId]);

  const loadReminders = useCallback(async () => {
    if (!clientId) return;
    try {
      setRemLoading(true);
      const res = await api.get(`/admin/reminders?clientId=${clientId}&limit=50`);
      setReminders(res.data?.reminders || []);
    } catch (_) { /* non-fatal */ }
    finally { setRemLoading(false); }
  }, [clientId]);

  useEffect(() => { load(); loadReminders(); }, [load, loadReminders]);

  const saveTags = async () => {
    try {
      setSavingTags(true);
      await api.put(`/admin/clients/${clientId}`, { tags });
      showSuccess('Tags updated');
      setTagsOpen(false);
      setData(d => d ? { ...d, client: { ...d.client, tags } } : d);
    } catch (e) { showError(e.response?.data?.error || 'Failed to update tags'); }
    finally { setSavingTags(false); }
  };

  const addReminder = async () => {
    if (!remTitle.trim()) return;
    try {
      setRemBusy(true);
      await api.post('/admin/reminders', { clientId, title: remTitle.trim(), dueDate: remDue || null });
      setRemTitle(''); setRemDue('');
      loadReminders();
    } catch (e) { showError(e.response?.data?.error || 'Failed to add reminder'); }
    finally { setRemBusy(false); }
  };

  const setReminderStatus = async (id, status) => {
    try {
      await api.patch(`/admin/reminders/${id}`, { status });
      setReminders(rs => rs.map(r => r._id === id ? { ...r, status } : r));
    } catch (e) { showError('Failed to update reminder'); }
  };

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading client detail">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 rounded-xl bg-genz-navy/10 animate-pulse" />)}
        </div>
        <div className="h-16 rounded-xl bg-genz-navy/10 animate-pulse" />
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-10 rounded-lg bg-genz-navy/10 animate-pulse" />)}
      </div>
    );
  }

  if (error || !data?.client) {
    return (
      <div className="text-center py-10">
        <AlertCircle size={26} className="mx-auto mb-2 text-genz-muted" />
        <p className="text-sm font-semibold text-genz-navy">Couldn't load client detail</p>
        <button onClick={load} className="text-xs text-genz-teal hover:underline mt-1">Try again</button>
      </div>
    );
  }

  const c = data.client;
  const logs = Array.isArray(data.activityLogs) ? data.activityLogs : [];
  const assignments = Array.isArray(data.assignments) ? data.assignments : [];
  const ext = data.extensionScan || null;
  const { active, expired, expiring } = computeHealth(assignments);
  const expiry = nearestExpiry(assignments);

  const waCtx = {
    client_name: (c.fullName || '').split(' ')[0] || c.fullName,
    client_email: c.email,
    tool_name: expiry?.tool,
    expiry_date: expiry?.date ? fmt(expiry.date, false) : '',
    latest_extension_version: ext?.extensionVersion || '',
  };
  const sendWhatsApp = (tpl) => {
    const msg = fillTemplate(tpl.body, waCtx);
    window.open(buildWhatsAppUrl(msg, c.phone), '_blank', 'noopener,noreferrer');
    setWaOpen(false);
  };

  const pendingReminders = reminders.filter(r => r.status === 'pending');

  return (
    <div className="space-y-5">
      {/* ── Health summary ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Status" value={c.status === 'active' ? 'Active' : 'Disabled'} tone={c.status === 'active' ? 'text-green-600' : 'text-red-500'} />
        <Stat label="Active tools" value={active} />
        <Stat label="Expired" value={expired} tone={expired ? 'text-red-500' : undefined} />
        <Stat label="Expiring ≤7d" value={expiring} tone={expiring ? 'text-amber-600' : undefined} />
        <Stat label="Last login" value={c.lastLoginAt ? fmt(c.lastLoginAt) : 'Never'} />
        <Stat label="Device" value={data.deviceBinding ? 'Bound' : 'None'} />
        <Stat label="Extension" value={ext?.extensionVersion ? `v${ext.extensionVersion}` : '—'} />
        <Stat label="Last sync" value={ext?.scannedAt ? fmt(ext.scannedAt) : '—'} />
      </div>

      {/* ── Tags ── */}
      <div className="border border-genz-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-genz-navy"><Tag size={15} className="text-genz-teal" /><span className="text-sm font-semibold">Tags</span></div>
          <button type="button" onClick={() => setTagsOpen(o => !o)} className="inline-flex items-center gap-1 text-xs font-medium text-genz-teal hover:underline">
            <Pencil size={12} /> {tagsOpen ? 'Close' : 'Edit'}
          </button>
        </div>
        {!tagsOpen ? (
          (c.tags && c.tags.length) ? (
            <div className="flex flex-wrap gap-1.5">{c.tags.map(t => <TagChip key={t} tag={t} />)}</div>
          ) : <p className="text-sm text-genz-muted italic">No tags yet.</p>
        ) : (
          <div className="space-y-3">
            <TagEditor value={tags} onChange={setTags} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setTags(c.tags || []); setTagsOpen(false); }} className="px-3 py-1.5 text-sm text-genz-muted hover:text-genz-navy">Cancel</button>
              <button type="button" onClick={saveTags} disabled={savingTags} className="btn-grad inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold disabled:opacity-50">
                {savingTags ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save tags
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── WhatsApp quick-send (manual) ── */}
      <div className="relative border border-genz-border rounded-xl p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-genz-navy"><MessageCircle size={15} className="text-emerald-600" /><span className="text-sm font-semibold">WhatsApp</span></div>
          <button type="button" onClick={() => setWaOpen(o => !o)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 text-sm font-semibold">
            Send message <ChevronDown size={14} className={`transition-transform ${waOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>
        <p className="text-[11px] text-genz-muted mt-1">
          {c.phone
            ? <>Saved number <span className="font-semibold text-emerald-600">+{c.phone}</span> — opens WhatsApp with a pre-filled message you review before sending.</>
            : <>No number saved — WhatsApp will let you pick the contact. Add one via <span className="font-medium">Edit</span>.</>}
        </p>
        {waOpen && (
          <div className="mt-3 grid sm:grid-cols-2 gap-1.5">
            {WA_TEMPLATES.map(t => (
              <button key={t.key} type="button" onClick={() => sendWhatsApp(t)}
                className="text-left px-3 py-2 rounded-lg border border-genz-border bg-genz-bg hover:border-emerald-300 hover:bg-emerald-50/50 text-sm text-genz-navy transition-colors">
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Follow-up reminders ── */}
      <div className="border border-genz-border rounded-xl p-4">
        <div className="flex items-center gap-2 text-genz-navy mb-3"><Bell size={15} className="text-genz-teal" /><span className="text-sm font-semibold">Follow-ups</span>
          {pendingReminders.length > 0 && <span className="ds-badge ds-badge-warn text-[10px]">{pendingReminders.length} pending</span>}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 mb-3">
          <input type="text" value={remTitle} onChange={e => setRemTitle(e.target.value)} placeholder="New follow-up (e.g. Call about renewal)"
            className="flex-1 px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal" data-testid="reminder-title" />
          <input type="date" value={remDue} onChange={e => setRemDue(e.target.value)}
            className="px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal" />
          <button type="button" onClick={addReminder} disabled={remBusy || !remTitle.trim()}
            className="btn-grad inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold disabled:opacity-50"><Plus size={14} /> Add</button>
        </div>
        {remLoading ? (
          <p className="text-sm text-genz-muted">Loading…</p>
        ) : reminders.length === 0 ? (
          <p className="text-sm text-genz-muted italic">No follow-ups for this client.</p>
        ) : (
          <ul className="space-y-1.5">
            {reminders.map(r => (
              <li key={r._id} className="flex items-center gap-2 text-sm">
                <span className={`flex-1 min-w-0 truncate ${r.status !== 'pending' ? 'line-through text-genz-muted' : 'text-genz-navy'}`}>
                  {r.title}{r.dueDate ? <span className="text-genz-muted"> · due {fmt(r.dueDate, false)}</span> : null}
                </span>
                {r.status === 'pending' ? (
                  <button type="button" onClick={() => setReminderStatus(r._id, 'done')}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-genz-border bg-white text-green-600 hover:bg-green-50 text-xs font-semibold">
                    <Check size={12} /> Done
                  </button>
                ) : (
                  <span className="text-[11px] text-genz-muted capitalize">{r.status}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Notes ── */}
      <div className="border border-genz-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-genz-navy"><FileText size={15} className="text-genz-teal" /><span className="text-sm font-semibold">Internal notes</span><span className="text-[11px] text-genz-muted">(payment / renewal)</span></div>
          <button type="button" onClick={() => (onEdit ? onEdit(c) : navigate(`/admin/clients/${c._id}/edit`))} className="inline-flex items-center gap-1 text-xs font-medium text-genz-teal hover:underline"><Pencil size={12} /> Edit</button>
        </div>
        {c.notes && String(c.notes).trim()
          ? <p className="text-sm text-genz-navy whitespace-pre-wrap break-words">{c.notes}</p>
          : <p className="text-sm text-genz-muted italic">No notes yet — add payment or renewal details in the client edit form.</p>}
      </div>

      {/* ── Timeline ── */}
      <div>
        <div className="flex items-center gap-2 text-genz-navy mb-2"><Clock size={15} className="text-genz-teal" /><span className="text-sm font-semibold">Recent activity</span><span className="text-[11px] text-genz-muted">(last {logs.length})</span></div>
        {logs.length === 0 ? (
          <p className="text-sm text-genz-muted py-4 text-center border border-genz-border rounded-xl">No recent activity recorded.</p>
        ) : (
          <ol className="relative border-l border-genz-border ml-2">
            {logs.map((l) => {
              const { Icon, tone, text } = describe(l);
              return (
                <li key={l._id} className="ml-4 pb-4 last:pb-0">
                  <span className="absolute -left-[9px] w-[18px] h-[18px] rounded-full bg-white border border-genz-border flex items-center justify-center"><Icon size={11} className={tone} /></span>
                  <p className="text-sm text-genz-navy">{text}</p>
                  <p className="text-[11px] text-genz-muted">{fmt(l.createdAt)}</p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
