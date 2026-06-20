import { useState, useEffect, useCallback } from 'react';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import { Megaphone, Plus, Trash2, Loader2, Eye, EyeOff, Info, CheckCircle2, AlertTriangle } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const LEVELS = [
  { key: 'info', label: 'Info', Icon: Info, cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  { key: 'success', label: 'Success', Icon: CheckCircle2, cls: 'bg-green-50 text-green-700 border-green-200' },
  { key: 'warning', label: 'Warning', Icon: AlertTriangle, cls: 'bg-amber-50 text-amber-700 border-amber-200' },
];
const levelMeta = (lvl) => LEVELS.find(l => l.key === lvl) || LEVELS[0];

const AdminAnnouncements = () => {
  const { showSuccess, showError } = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ title: '', body: '', level: 'info', active: true });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/admin/announcements');
      setItems(res.data?.announcements || []);
    } catch (_) { showError('Failed to load announcements'); }
    finally { setLoading(false); }
  }, [showError]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.title.trim()) { showError('Title is required'); return; }
    try {
      setSaving(true);
      await api.post('/admin/announcements', form);
      setForm({ title: '', body: '', level: 'info', active: true });
      showSuccess('Announcement published');
      load();
    } catch (e) { showError(e.response?.data?.error || 'Failed to create'); }
    finally { setSaving(false); }
  };

  const toggle = async (a) => {
    try {
      await api.patch(`/admin/announcements/${a._id}`, { active: !a.active });
      setItems(list => list.map(x => x._id === a._id ? { ...x, active: !a.active } : x));
    } catch (_) { showError('Failed to update'); }
  };

  const remove = async (a) => {
    if (!window.confirm('Delete this announcement?')) return;
    try {
      await api.delete(`/admin/announcements/${a._id}`);
      setItems(list => list.filter(x => x._id !== a._id));
    } catch (_) { showError('Failed to delete'); }
  };

  const inputCls = 'w-full px-3.5 py-2.5 text-sm bg-genz-bg border border-genz-border rounded-xl text-genz-navy placeholder:text-genz-muted focus:outline-none focus:border-genz-teal/50 focus:ring-2 focus:ring-genz-teal/20 transition-all';

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-4xl mx-auto space-y-5">
        <div>
          <h1 className="font-heading text-2xl font-extrabold text-genz-navy flex items-center gap-2.5">
            <span className="ds-icon-grad w-9 h-9 rounded-xl flex items-center justify-center"><Megaphone size={18} /></span>
            Announcements
          </h1>
          <p className="text-sm text-genz-muted mt-0.5">Notices shown to clients on their dashboard. Only “published” ones are visible.</p>
        </div>

        {/* Compose */}
        <div className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4 space-y-3`}>
          <input className={inputCls} placeholder="Title (e.g. Scheduled maintenance Sunday)" value={form.title}
            maxLength={160} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} data-testid="ann-title" />
          <textarea className={`${inputCls} resize-none`} rows={3} placeholder="Message (optional)…" value={form.body}
            maxLength={2000} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} />
          <div className="flex flex-wrap items-center gap-2">
            {LEVELS.map(l => (
              <button key={l.key} type="button" onClick={() => setForm(f => ({ ...f, level: l.key }))}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${form.level === l.key ? l.cls : 'bg-genz-bg text-genz-muted border-genz-border hover:border-genz-teal/40'}`}>
                <l.Icon size={13} /> {l.label}
              </button>
            ))}
            <label className="ml-auto inline-flex items-center gap-2 text-sm text-genz-navy cursor-pointer">
              <input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="w-4 h-4 accent-genz-teal" />
              Publish now
            </label>
            <button onClick={create} disabled={saving || !form.title.trim()}
              className="btn-grad inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50" data-testid="ann-create">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Publish
            </button>
          </div>
        </div>

        {/* List */}
        {loading ? (
          <div className="space-y-2" aria-busy="true">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-20 rounded-2xl bg-genz-navy/5 animate-pulse" />)}</div>
        ) : items.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-10 text-center`}>
            <Megaphone size={28} className="mx-auto mb-2 text-genz-muted" />
            <p className="text-sm font-semibold text-genz-navy">No announcements yet</p>
            <p className="text-xs text-genz-muted mt-0.5">Publish one above and clients will see it on their dashboard.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map(a => {
              const m = levelMeta(a.level);
              return (
                <div key={a._id} className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4`}>
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border ${m.cls}`}><m.Icon size={15} /></span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-genz-navy">{a.title}</p>
                        <span className={`ds-badge ${a.active ? 'ds-badge-success' : 'ds-badge-neutral'} !text-[10px]`}>{a.active ? 'Published' : 'Draft'}</span>
                      </div>
                      {a.body && <p className="text-sm text-genz-muted mt-1 whitespace-pre-wrap break-words">{a.body}</p>}
                      <p className="text-[11px] text-genz-muted/70 mt-1.5">{a.createdAt ? new Date(a.createdAt).toLocaleString() : ''}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button onClick={() => toggle(a)} title={a.active ? 'Unpublish' : 'Publish'}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-genz-border bg-genz-bg text-genz-teal hover:bg-genz-teal/10 transition-colors">
                        {a.active ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      <button onClick={() => remove(a)} title="Delete"
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-genz-border bg-genz-bg text-red-500 hover:bg-red-500/10 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminAnnouncements;
