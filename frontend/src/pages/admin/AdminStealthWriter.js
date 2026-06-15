import { useState, useEffect, useCallback } from 'react';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import {
  Sparkles, Plus, RefreshCw, Trash2, Edit2, ShieldOff, Clock,
  Loader2, X, Save, Eye, Settings as SettingsIcon, Users, Zap
} from 'lucide-react';
import { stealthAdmin } from '../../services/stealthService';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const fmtDate = (d) => { if (!d) return '—'; const dt = new Date(d); return isNaN(dt.getTime()) ? '—' : dt.toLocaleString(); };
const fmtLimit = (used, remaining, limit) => limit < 0 ? `${used} (∞)` : `${used}/${limit} · ${remaining} left`;
const toDateInput = (d) => { if (!d) return ''; const dt = new Date(d); return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10); };

const StatCard = ({ icon: Icon, label, value, color }) => (
  <div className="ds-card rounded-xl p-4 flex items-center gap-3">
    <span className={`w-10 h-10 rounded-lg flex items-center justify-center text-white bg-gradient-to-br ${color}`}><Icon size={18} /></span>
    <div><p className="text-2xl font-bold text-slate-800 leading-none">{value ?? '—'}</p><p className="text-xs text-slate-500 mt-1">{label}</p></div>
  </div>
);

const AdminStealthWriter = () => {
  const { showSuccess, showError } = useToast();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [clients, setClients] = useState([]);
  const [crmClients, setCrmClients] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [s, st, cl] = await Promise.all([
        stealthAdmin.getSettings(), stealthAdmin.getStats(), stealthAdmin.listClients({ limit: 100 }),
      ]);
      setSettings(s.data.settings);
      setStats(st.data.stats);
      setClients(cl.data.clients || []);
    } catch (e) {
      showError(e.response?.data?.error || 'Failed to load StealthWriter module');
    } finally { setLoading(false); }
  }, [showError]);

  useEffect(() => { load(); }, [load]);

  const loadCrmClients = async () => {
    try {
      const res = await api.get('/admin/clients?limit=100');
      setCrmClients(res.data.clients || []);
    } catch { /* non-fatal */ }
  };

  const saveSettings = async () => {
    try {
      const res = await stealthAdmin.updateSettings({
        leaseDurationMinutes: Number(settings.leaseDurationMinutes),
        fixedLeaseEnabled: !!settings.fixedLeaseEnabled,
        maxSessionMinutes: Number(settings.maxSessionMinutes),
      });
      setSettings(res.data.settings);
      showSuccess('Settings saved');
    } catch (e) { showError(e.response?.data?.error || 'Failed to save settings'); }
  };

  const doAction = async (fn, msg) => {
    try { await fn(); showSuccess(msg); load(); }
    catch (e) { showError(e.response?.data?.error || 'Action failed'); }
  };

  return (
    <AdminLayoutEnhanced>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white bg-gradient-to-br from-violet-500 to-fuchsia-500"><Sparkles size={22} /></span>
          <div><h1 className="font-heading text-xl font-bold text-slate-800">StealthWriter</h1>
            <p className="text-sm text-slate-500">Manage StealthWriter plans, limits, leases and usage.</p></div>
        </div>
        <button onClick={() => { setShowCreate(true); loadCrmClients(); }}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-600 to-cyan-500 hover:opacity-95">
          <Plus size={17} /> Add client
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="animate-spin mr-2" size={20} /> Loading…</div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <StatCard icon={Users} label="Total clients" value={stats?.totalClients} color="from-blue-500 to-cyan-500" />
            <StatCard icon={Zap} label="Active" value={stats?.activeClients} color="from-green-500 to-emerald-500" />
            <StatCard icon={Clock} label="Active leases" value={stats?.activeLeases} color="from-violet-500 to-fuchsia-500" />
            <StatCard icon={ShieldOff} label="Expired" value={stats?.expiredClients} color="from-amber-500 to-orange-500" />
          </div>

          {/* Settings */}
          {settings && (
            <div className="ds-card rounded-xl p-5 mb-5">
              <div className="flex items-center gap-2 mb-3"><SettingsIcon size={16} className="text-slate-500" /><h2 className="font-semibold text-slate-700">Lease settings</h2></div>
              <div className="grid sm:grid-cols-3 gap-4 items-end">
                <label className="text-sm">
                  <span className="block text-slate-600 mb-1">Lease duration (minutes)</span>
                  <input type="number" min="1" max="720" value={settings.leaseDurationMinutes}
                    onChange={(e) => setSettings({ ...settings, leaseDurationMinutes: e.target.value })}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2" />
                </label>
                <label className="text-sm">
                  <span className="block text-slate-600 mb-1">Max session when fixed lease off (min)</span>
                  <input type="number" min="5" max="1440" value={settings.maxSessionMinutes}
                    onChange={(e) => setSettings({ ...settings, maxSessionMinutes: e.target.value })}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2" />
                </label>
                <label className="flex items-center gap-2 text-sm pb-2">
                  <input type="checkbox" checked={!!settings.fixedLeaseEnabled}
                    onChange={(e) => setSettings({ ...settings, fixedLeaseEnabled: e.target.checked })} />
                  <span className="text-slate-600">Enforce fixed lease (countdown)</span>
                </label>
              </div>
              <p className="text-[12px] text-slate-400 mt-2">Even with fixed lease off, the backend still validates status, expiry and usage limits on every action.</p>
              <button onClick={saveSettings} className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-slate-800 hover:bg-slate-700"><Save size={15} /> Save settings</button>
            </div>
          )}

          {/* Clients table */}
          <div className="ds-card rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <h2 className="font-semibold text-slate-700">StealthWriter clients</h2>
              <button onClick={load} className="text-slate-400 hover:text-slate-600"><RefreshCw size={16} /></button>
            </div>
            {clients.length === 0 ? (
              <p className="p-8 text-center text-slate-400 text-sm">No StealthWriter clients yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-slate-500 border-b border-slate-100">
                    <th className="px-4 py-2 font-medium">Client</th><th className="px-4 py-2 font-medium">Plan</th>
                    <th className="px-4 py-2 font-medium">Humanizer</th><th className="px-4 py-2 font-medium">AI Detector</th>
                    <th className="px-4 py-2 font-medium">Expiry</th><th className="px-4 py-2 font-medium">Leases</th>
                    <th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2 font-medium text-right">Actions</th>
                  </tr></thead>
                  <tbody>
                    {clients.map((c) => (
                      <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-700">{c.user?.fullName || '—'}</div>
                          <div className="text-[12px] text-slate-400">{c.user?.email || c.userId}</div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{c.planName}</td>
                        <td className="px-4 py-2.5 text-slate-600">{fmtLimit(c.used.humanizer, c.remaining.humanizer, c.limits.humanizer)}</td>
                        <td className="px-4 py-2.5 text-slate-600">{fmtLimit(c.used.detector, c.remaining.detector, c.limits.detector)}</td>
                        <td className="px-4 py-2.5 text-slate-600">{c.expiryDate ? toDateInput(c.expiryDate) : 'None'}{c.expired && <span className="ml-1 text-[11px] text-red-600">(expired)</span>}</td>
                        <td className="px-4 py-2.5 text-slate-600">{c.activeLeaseCount}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${c.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{c.status}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1.5 text-slate-400">
                            <button title="View" onClick={async () => { const r = await stealthAdmin.getClient(c.id); setDetail(r.data); }} className="hover:text-blue-600"><Eye size={16} /></button>
                            <button title="Edit" onClick={() => setEditing({ ...c })} className="hover:text-slate-700"><Edit2 size={16} /></button>
                            <button title="Reset usage" onClick={() => window.confirm('Reset usage for this client?') && doAction(() => stealthAdmin.resetUsage(c.id), 'Usage reset')} className="hover:text-amber-600"><RefreshCw size={16} /></button>
                            <button title="Revoke leases" onClick={() => window.confirm('Revoke all active leases?') && doAction(() => stealthAdmin.revokeLeases(c.id), 'Leases revoked')} className="hover:text-orange-600"><ShieldOff size={16} /></button>
                            <button title="Delete" onClick={() => window.confirm('Delete this StealthWriter client?') && doAction(() => stealthAdmin.deleteClient(c.id), 'Client deleted')} className="hover:text-red-600"><Trash2 size={16} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {showCreate && <CreateModal crmClients={crmClients} onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); load(); }} showError={showError} showSuccess={showSuccess} />}
      {editing && <EditModal client={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }} showError={showError} showSuccess={showSuccess} />}
      {detail && <DetailModal detail={detail} onClose={() => setDetail(null)} onRevokeLease={async (lid) => { await stealthAdmin.revokeLease(lid); const r = await stealthAdmin.getClient(detail.client.id); setDetail(r.data); }} />}
    </AdminLayoutEnhanced>
  );
};

// ── Modal shell ───────────────────────────────────────────────────────────────
const Modal = ({ title, onClose, children, wide }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50" onClick={onClose}>
    <div className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white">
        <h3 className="font-semibold text-slate-800">{title}</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
      </div>
      <div className="p-5">{children}</div>
    </div>
  </div>
);

const Field = ({ label, children }) => (
  <label className="block text-sm mb-3"><span className="block text-slate-600 mb-1">{label}</span>{children}</label>
);
const inputCls = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm';

const CreateModal = ({ crmClients, onClose, onCreated, showError, showSuccess }) => {
  const [form, setForm] = useState({ userId: '', planName: 'StealthWriter', dailyHumanizerLimit: 50, dailyDetectorLimit: 50, expiryDate: '', status: 'active' });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!form.userId) return showError('Select a client');
    try {
      setSaving(true);
      await stealthAdmin.createClient({
        userId: form.userId, planName: form.planName,
        dailyHumanizerLimit: Number(form.dailyHumanizerLimit), dailyDetectorLimit: Number(form.dailyDetectorLimit),
        expiryDate: form.expiryDate || null, status: form.status,
      });
      showSuccess('StealthWriter client created'); onCreated();
    } catch (e) { showError(e.response?.data?.error || 'Failed to create'); } finally { setSaving(false); }
  };
  return (
    <Modal title="Add StealthWriter client" onClose={onClose}>
      <Field label="CRM client">
        <select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} className={inputCls}>
          <option value="">Select a client…</option>
          {crmClients.map((u) => <option key={u._id} value={u._id}>{u.fullName} — {u.email}</option>)}
        </select>
      </Field>
      <Field label="Plan name"><input className={inputCls} value={form.planName} onChange={(e) => setForm({ ...form, planName: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Daily humanizer limit (-1 = ∞)"><input type="number" className={inputCls} value={form.dailyHumanizerLimit} onChange={(e) => setForm({ ...form, dailyHumanizerLimit: e.target.value })} /></Field>
        <Field label="Daily detector limit (-1 = ∞)"><input type="number" className={inputCls} value={form.dailyDetectorLimit} onChange={(e) => setForm({ ...form, dailyDetectorLimit: e.target.value })} /></Field>
      </div>
      <Field label="Expiry date (optional)"><input type="date" className={inputCls} value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} /></Field>
      <Field label="Status">
        <select className={inputCls} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="active">active</option><option value="disabled">disabled</option></select>
      </Field>
      <button onClick={submit} disabled={saving} className="w-full mt-2 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold text-white bg-gradient-to-r from-blue-600 to-cyan-500 disabled:opacity-60">
        {saving ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />} Create
      </button>
    </Modal>
  );
};

const EditModal = ({ client, onClose, onSaved, showError, showSuccess }) => {
  const [form, setForm] = useState({
    planName: client.planName, dailyHumanizerLimit: client.limits.humanizer, dailyDetectorLimit: client.limits.detector,
    expiryDate: toDateInput(client.expiryDate), status: client.status,
  });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    try {
      setSaving(true);
      await stealthAdmin.updateClient(client.id, {
        planName: form.planName, dailyHumanizerLimit: Number(form.dailyHumanizerLimit), dailyDetectorLimit: Number(form.dailyDetectorLimit),
        expiryDate: form.expiryDate || null, status: form.status,
      });
      showSuccess('Client updated'); onSaved();
    } catch (e) { showError(e.response?.data?.error || 'Failed to update'); } finally { setSaving(false); }
  };
  return (
    <Modal title={`Edit — ${client.user?.fullName || client.userId}`} onClose={onClose}>
      <Field label="Plan name"><input className={inputCls} value={form.planName} onChange={(e) => setForm({ ...form, planName: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Daily humanizer limit (-1 = ∞)"><input type="number" className={inputCls} value={form.dailyHumanizerLimit} onChange={(e) => setForm({ ...form, dailyHumanizerLimit: e.target.value })} /></Field>
        <Field label="Daily detector limit (-1 = ∞)"><input type="number" className={inputCls} value={form.dailyDetectorLimit} onChange={(e) => setForm({ ...form, dailyDetectorLimit: e.target.value })} /></Field>
      </div>
      <Field label="Expiry date"><input type="date" className={inputCls} value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} /></Field>
      <Field label="Status">
        <select className={inputCls} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="active">active</option><option value="disabled">disabled</option></select>
      </Field>
      <button onClick={submit} disabled={saving} className="w-full mt-2 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold text-white bg-slate-800 disabled:opacity-60">
        {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />} Save
      </button>
    </Modal>
  );
};

const DetailModal = ({ detail, onClose, onRevokeLease }) => {
  const { client, usageLogs = [], leases = [] } = detail;
  return (
    <Modal title={`${client.user?.fullName || client.userId} — detail`} onClose={onClose} wide>
      <h4 className="font-semibold text-slate-700 mb-2 text-sm">Active & recent leases</h4>
      {leases.length === 0 ? <p className="text-sm text-slate-400 mb-4">No leases.</p> : (
        <div className="overflow-x-auto mb-5"><table className="w-full text-[12.5px]">
          <thead><tr className="text-left text-slate-500 border-b"><th className="py-1.5 pr-2">Issued</th><th className="py-1.5 pr-2">Expires</th><th className="py-1.5 pr-2">State</th><th className="py-1.5 text-right">—</th></tr></thead>
          <tbody>{leases.map((l) => (
            <tr key={l.id} className="border-b border-slate-50">
              <td className="py-1.5 pr-2 text-slate-600">{fmtDate(l.issuedAt)}</td>
              <td className="py-1.5 pr-2 text-slate-600">{fmtDate(l.expiresAt)}</td>
              <td className="py-1.5 pr-2">{l.revoked ? <span className="text-red-600">revoked</span> : l.active ? <span className="text-green-600">active</span> : <span className="text-slate-400">expired</span>}</td>
              <td className="py-1.5 text-right">{l.active && !l.revoked && <button onClick={() => onRevokeLease(l.id)} className="text-orange-600 hover:underline">revoke</button>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      <h4 className="font-semibold text-slate-700 mb-2 text-sm">Recent usage</h4>
      {usageLogs.length === 0 ? <p className="text-sm text-slate-400">No usage yet.</p> : (
        <div className="overflow-x-auto max-h-64"><table className="w-full text-[12.5px]">
          <thead><tr className="text-left text-slate-500 border-b"><th className="py-1.5 pr-2">Time</th><th className="py-1.5 pr-2">Action</th><th className="py-1.5 pr-2">Result</th><th className="py-1.5">Reason</th></tr></thead>
          <tbody>{usageLogs.map((u) => (
            <tr key={u._id} className="border-b border-slate-50">
              <td className="py-1.5 pr-2 text-slate-600">{fmtDate(u.createdAt)}</td>
              <td className="py-1.5 pr-2 text-slate-600">{u.action}</td>
              <td className="py-1.5 pr-2">{u.allowed ? <span className="text-green-600">allowed</span> : <span className="text-red-600">blocked</span>}</td>
              <td className="py-1.5 text-slate-500">{u.reason}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Modal>
  );
};

export default AdminStealthWriter;
