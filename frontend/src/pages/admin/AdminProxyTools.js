import { useState, useEffect, useCallback } from 'react';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import {
  Zap, Plus, RefreshCw, Trash2, Loader2, X, Save, Users, KeyRound,
  Star, ShieldCheck, ShieldOff, Globe, List, CheckCircle2
} from 'lucide-react';
import { proxyToolsAdmin } from '../../services/proxyToolsService';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const fmtDate = (d) => { if (!d) return '—'; const dt = new Date(d); return isNaN(dt.getTime()) ? '—' : dt.toLocaleString(); };
const toDateInput = (d) => { if (!d) return ''; const dt = new Date(d); return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10); };

const ACCOUNT_STATUSES = ['active', 'standby', 'limit_reached', 'session_expired', 'blocked'];
const STATUS_BADGE = {
  active: 'bg-green-100 text-green-700', standby: 'bg-slate-100 text-slate-600',
  limit_reached: 'bg-amber-100 text-amber-700', session_expired: 'bg-red-100 text-red-700',
  blocked: 'bg-red-100 text-red-700',
};

const StatCard = ({ icon: Icon, label, value, color }) => (
  <div className="ds-card rounded-xl p-4 flex items-center gap-3">
    <span className={`w-10 h-10 rounded-lg flex items-center justify-center text-white bg-gradient-to-br ${color}`}><Icon size={18} /></span>
    <div><p className="text-2xl font-bold text-slate-800 leading-none">{value ?? '—'}</p><p className="text-xs text-slate-500 mt-1">{label}</p></div>
  </div>
);

const AdminProxyTools = () => {
  const { showSuccess, showError } = useToast();
  const [toolDefs, setToolDefs] = useState([]);
  const [tool, setTool] = useState('hix');
  const [section, setSection] = useState('accounts'); // 'accounts' | 'clients'
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [clients, setClients] = useState([]);
  const [crmClients, setCrmClients] = useState([]);

  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editAccount, setEditAccount] = useState(null);
  const [showSessionModal, setShowSessionModal] = useState(null); // account being (re)filled
  const [showClientModal, setShowClientModal] = useState(false);
  const [editClient, setEditClient] = useState(null);

  const loadDefs = useCallback(async () => {
    try { const r = await proxyToolsAdmin.listTools(); setToolDefs(r.data?.tools || []); } catch (_) {}
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [st, ac, cl] = await Promise.all([
        proxyToolsAdmin.getStats(tool),
        proxyToolsAdmin.listAccounts(tool),
        proxyToolsAdmin.listClients(tool, { limit: 100 }),
      ]);
      setStats(st.data?.stats || null);
      setAccounts(ac.data?.accounts || []);
      setClients(cl.data?.clients || []);
    } catch (e) {
      // A raw backend "Route not found" here means the proxy-tools API is not
      // mounted on the running server (typically a stale backend deploy), NOT a
      // bug in this page. Make that explicit instead of echoing the cryptic
      // server string. The api client logs the exact method + path safely.
      const status = e.response?.status;
      const serverMsg = e.response?.data?.error;
      showError(
        status === 404 || serverMsg === 'Route not found'
          ? 'Failed to load Proxy Tools — the proxy-tools API route is unavailable (404). The backend may need to be redeployed.'
          : status
            ? `Failed to load Proxy Tools (HTTP ${status})${serverMsg ? ` — ${serverMsg}` : ''}`
            : 'Failed to load Proxy Tools — could not reach the server.'
      );
    } finally { setLoading(false); }
  }, [tool, showError]);

  useEffect(() => { loadDefs(); }, [loadDefs]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // CRM client list for the "grant access" dropdown.
    api.get('/admin/clients?limit=100').then(r => setCrmClients(r.data?.clients || [])).catch(() => {});
  }, []);

  const currentName = (toolDefs.find(t => t.tool === tool) || {}).name || tool;

  // ── Account actions ─────────────────────────────────────────────────────────
  const saveAccount = async (form) => {
    try {
      if (editAccount) await proxyToolsAdmin.updateAccount(tool, editAccount.id, form);
      else await proxyToolsAdmin.createAccount(tool, form);
      showSuccess('Account saved'); setShowAccountModal(false); setEditAccount(null); load();
    } catch (e) { showError(e.response?.data?.error || 'Failed to save account'); }
  };
  const saveSession = async (id, sessionBundle) => {
    try { await proxyToolsAdmin.refreshAccountSession(tool, id, sessionBundle); showSuccess('Cookies updated'); setShowSessionModal(null); load(); }
    catch (e) { showError(e.response?.data?.error || 'Failed to update cookies'); }
  };
  const verify = async (id) => { try { const r = await proxyToolsAdmin.verifyAccount(tool, id); showSuccess(`Verify: ${r.data?.result || 'done'}`); load(); } catch (e) { showError(e.response?.data?.error || 'Verify failed'); } };
  const setPrimary = async (id) => { try { await proxyToolsAdmin.setAccountPrimary(tool, id); showSuccess('Primary set'); load(); } catch (e) { showError('Failed'); } };
  const setStatus = async (id, status) => { try { await proxyToolsAdmin.setAccountStatus(tool, id, status); load(); } catch (e) { showError('Failed to set status'); } };
  const captureLease = async (id) => { try { const r = await proxyToolsAdmin.captureLease(tool, id); if (r.data?.url) window.open(r.data.url, '_blank', 'noopener'); } catch (e) { showError('Failed to start capture'); } };
  const revokeAccountLeases = async (id) => { if (!window.confirm('Revoke all active sessions using this account?')) return; try { const r = await proxyToolsAdmin.revokeAccountLeases(tool, id); showSuccess(`Revoked ${r.data?.revoked || 0}`); load(); } catch (e) { showError('Failed'); } };
  const deleteAccount = async (id) => { if (!window.confirm('Delete this account? Cookies are wiped and its sessions revoked.')) return; try { await proxyToolsAdmin.deleteAccount(tool, id); showSuccess('Account deleted'); load(); } catch (e) { showError('Failed'); } };

  // ── Client actions ──────────────────────────────────────────────────────────
  const saveClient = async (form) => {
    try {
      if (editClient) await proxyToolsAdmin.updateClient(tool, editClient.id, { planName: form.planName, expiryDate: form.expiryDate || null, status: form.status });
      else await proxyToolsAdmin.createClient(tool, form);
      showSuccess('Access saved'); setShowClientModal(false); setEditClient(null); load();
    } catch (e) { showError(e.response?.data?.error || 'Failed to save access'); }
  };
  const removeClient = async (id) => { if (!window.confirm('Remove this client\'s access to the tool?')) return; try { await proxyToolsAdmin.deleteClient(tool, id); showSuccess('Access removed'); load(); } catch (e) { showError('Failed'); } };
  const revokeClientLeases = async (id) => { try { const r = await proxyToolsAdmin.revokeClientLeases(tool, id); showSuccess(`Revoked ${r.data?.revoked || 0}`); load(); } catch (e) { showError('Failed'); } };

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-7xl mx-auto space-y-5" data-testid="admin-proxy-tools-page">
        {/* Header */}
        <div className="flex items-center gap-3">
          <span className="ds-icon-grad w-10 h-10 rounded-xl flex items-center justify-center"><Zap size={20} /></span>
          <div>
            <h1 className="font-heading text-2xl font-extrabold text-genz-navy">Proxy Tools</h1>
            <p className="text-sm text-genz-muted">HIX AI and BypassGPT — separate tools, each with its own encrypted cookie vault</p>
          </div>
          <button onClick={load} className="ml-auto text-genz-muted hover:text-genz-navy" title="Refresh"><RefreshCw size={18} /></button>
        </div>

        {/* Tool tabs (each tool is fully independent) */}
        <div className="flex items-center gap-2">
          {(toolDefs.length ? toolDefs : [{ tool: 'hix', name: 'HIX AI' }, { tool: 'bypassgpt', name: 'BypassGPT' }]).map(t => (
            <button key={t.tool} onClick={() => setTool(t.tool)}
              className={`px-4 py-2 rounded-xl text-sm font-bold transition-colors ${tool === t.tool ? 'btn-grad' : 'bg-genz-bg text-genz-muted border border-genz-border hover:border-genz-teal/50'}`}>
              {t.name}
            </button>
          ))}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={Users} label="Clients with access" value={stats?.activeClients} color="from-blue-500 to-cyan-500" />
          <StatCard icon={KeyRound} label="Vault accounts" value={stats?.totalAccounts} color="from-violet-500 to-fuchsia-500" />
          <StatCard icon={ShieldCheck} label="Available accounts" value={stats?.availableAccounts} color="from-emerald-500 to-green-500" />
          <StatCard icon={Globe} label="Active sessions" value={stats?.activeLeases} color="from-amber-500 to-orange-500" />
        </div>

        {/* Section switch */}
        <div className="flex items-center gap-2 border-b border-genz-border">
          {[['accounts', 'Account Vault'], ['clients', 'Client Access']].map(([k, label]) => (
            <button key={k} onClick={() => setSection(k)}
              className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${section === k ? 'border-genz-teal text-genz-navy' : 'border-transparent text-genz-muted hover:text-genz-navy'}`}>
              {label}
            </button>
          ))}
          <button
            onClick={() => { if (section === 'accounts') { setEditAccount(null); setShowAccountModal(true); } else { setEditClient(null); setShowClientModal(true); } }}
            className="ml-auto mb-1.5 btn-grad inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-bold">
            <Plus size={15} /> {section === 'accounts' ? `Add ${currentName} account` : 'Grant access'}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-genz-muted"><Loader2 className="animate-spin mr-2" size={20} /> Loading…</div>
        ) : section === 'accounts' ? (
          <AccountVault
            accounts={accounts} toolName={currentName}
            onEdit={(a) => { setEditAccount(a); setShowAccountModal(true); }}
            onSession={(a) => setShowSessionModal(a)}
            onVerify={verify} onPrimary={setPrimary} onStatus={setStatus}
            onCapture={captureLease} onRevoke={revokeAccountLeases} onDelete={deleteAccount}
          />
        ) : (
          <ClientAccess clients={clients} onEdit={(c) => { setEditClient(c); setShowClientModal(true); }} onRevoke={revokeClientLeases} onRemove={removeClient} />
        )}
      </div>

      {showAccountModal && <AccountModal account={editAccount} toolName={currentName} onClose={() => { setShowAccountModal(false); setEditAccount(null); }} onSave={saveAccount} />}
      {showSessionModal && <SessionModal account={showSessionModal} onClose={() => setShowSessionModal(null)} onSave={saveSession} />}
      {showClientModal && <ClientModal client={editClient} crmClients={crmClients} existing={clients} onClose={() => { setShowClientModal(false); setEditClient(null); }} onSave={saveClient} />}
    </AdminLayoutEnhanced>
  );
};

// ── Account Vault list ────────────────────────────────────────────────────────
const AccountVault = ({ accounts, toolName, onEdit, onSession, onVerify, onPrimary, onStatus, onCapture, onRevoke, onDelete }) => {
  if (!accounts.length) {
    return <div className="ds-card rounded-xl p-10 text-center text-genz-muted"><KeyRound size={28} className="mx-auto mb-3 opacity-60" />No {toolName} accounts yet. Add one and paste its cookie bundle.</div>;
  }
  return (
    <div className="space-y-2.5">
      {accounts.map(a => (
        <div key={a.id} className="ds-card rounded-xl p-4" data-testid={`proxy-account-${a.id}`}>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-bold text-genz-navy flex items-center gap-1.5">
              {a.isPrimary && <Star size={14} className="text-amber-500 fill-amber-400" />}{a.label}
            </span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${STATUS_BADGE[a.status] || 'bg-slate-100'}`}>{a.status}</span>
            {a.available ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold">available</span>
              : <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-semibold">{a.unavailableReason}</span>}
            <span className="text-[11px] text-genz-muted">cookies: {a.sessionMeta?.attachableCount ?? a.sessionMeta?.cookieCount ?? 0}</span>
            {a.maskedIdentifier && <span className="text-[11px] text-genz-muted">· {a.maskedIdentifier}</span>}
            <span className="text-[11px] text-genz-muted">· active sessions: {a.activeLeaseCount}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-3">
            <Btn onClick={() => onSession(a)} icon={KeyRound} label="Update cookies" />
            <Btn onClick={() => onVerify(a.id)} icon={ShieldCheck} label="Verify" tone="teal" />
            <Btn onClick={() => onCapture(a.id)} icon={Globe} label="Capture via proxy" tone="teal" />
            {!a.isPrimary && <Btn onClick={() => onPrimary(a.id)} icon={Star} label="Set primary" tone="amber" />}
            <select value={a.status} onChange={(e) => onStatus(a.id, e.target.value)}
              className="h-8 px-2 text-xs bg-genz-bg border border-genz-border rounded-lg text-genz-navy">
              {ACCOUNT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <Btn onClick={() => onEdit(a)} icon={Save} label="Edit" />
            <Btn onClick={() => onRevoke(a.id)} icon={ShieldOff} label="Revoke sessions" tone="amber" />
            <Btn onClick={() => onDelete(a.id)} icon={Trash2} label="Delete" tone="red" />
          </div>
        </div>
      ))}
    </div>
  );
};

// ── Client Access list ────────────────────────────────────────────────────────
const ClientAccess = ({ clients, onEdit, onRevoke, onRemove }) => {
  if (!clients.length) return <div className="ds-card rounded-xl p-10 text-center text-genz-muted"><Users size={28} className="mx-auto mb-3 opacity-60" />No clients have access yet.</div>;
  return (
    <div className="ds-card rounded-xl overflow-hidden">
      <table className="ds-table">
        <thead><tr><th>Client</th><th>Status</th><th>Expiry</th><th>Sessions</th><th className="text-right">Actions</th></tr></thead>
        <tbody>
          {clients.map(c => (
            <tr key={c.id} data-testid={`proxy-client-${c.id}`}>
              <td>
                <p className="font-semibold text-genz-navy text-sm">{c.user?.fullName || '—'}</p>
                <p className="text-xs text-genz-muted">{c.user?.email}</p>
              </td>
              <td>
                <span className={`ds-badge ${c.expired ? 'ds-badge-danger' : (c.status === 'active' ? 'ds-badge-success' : 'ds-badge-neutral')}`}>
                  <span className="dot" /> {c.expired ? 'expired' : c.status}
                </span>
              </td>
              <td className="text-xs text-genz-muted">{c.expiryDate ? fmtDate(c.expiryDate) : 'No expiry'}</td>
              <td className="text-xs">{c.activeLeaseCount}</td>
              <td>
                <div className="flex items-center justify-end gap-1.5">
                  <Btn onClick={() => onEdit(c)} icon={Save} label="Edit" />
                  <Btn onClick={() => onRevoke(c.id)} icon={ShieldOff} label="Revoke" tone="amber" />
                  <Btn onClick={() => onRemove(c.id)} icon={Trash2} label="Remove" tone="red" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Btn = ({ onClick, icon: Icon, label, tone }) => {
  const tones = { teal: 'text-genz-teal', amber: 'text-amber-500', red: 'text-red-500' };
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-genz-border bg-genz-bg text-[12.5px] font-medium hover:border-genz-teal/50 transition-colors ${tones[tone] || 'text-genz-navy'}`}>
      <Icon size={13} /> {label}
    </button>
  );
};

// ── Modals ────────────────────────────────────────────────────────────────────
const Shell = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-[9990] flex items-center justify-center p-4">
    <div className="absolute inset-0 bg-genz-navy/40 backdrop-blur-sm" onClick={onClose} />
    <div className="relative w-full max-w-lg bg-white border border-genz-border rounded-2xl shadow-2xl p-5 max-h-[90vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-bold text-genz-navy">{title}</h3>
        <button onClick={onClose} className="text-genz-muted hover:text-genz-navy"><X size={18} /></button>
      </div>
      {children}
    </div>
  </div>
);

const field = "w-full px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal";
const labelCls = "block text-xs font-medium text-genz-navy mb-1";

const AccountModal = ({ account, toolName, onClose, onSave }) => {
  const [f, setF] = useState({
    label: account?.label || '', expectedIdentifier: account?.hasExpectedIdentifier ? '' : '',
    sessionBundle: '', status: account?.status || 'active', priority: account?.priority ?? 100, isPrimary: account?.isPrimary || false,
  });
  const submit = () => {
    if (!f.label.trim()) return;
    const body = { label: f.label.trim(), status: f.status, priority: Number(f.priority) || 100, isPrimary: !!f.isPrimary };
    if (f.expectedIdentifier.trim()) body.expectedIdentifier = f.expectedIdentifier.trim();
    if (!account && f.sessionBundle.trim()) body.sessionBundle = f.sessionBundle.trim();
    onSave(body);
  };
  return (
    <Shell title={account ? `Edit account` : `Add ${toolName} account`} onClose={onClose}>
      <div className="space-y-3">
        <div><label className={labelCls}>Label</label><input className={field} value={f.label} onChange={e => setF({ ...f, label: e.target.value })} placeholder="e.g. HIX Account 1" /></div>
        <div><label className={labelCls}>Expected login (optional, e.g. email)</label><input className={field} value={f.expectedIdentifier} onChange={e => setF({ ...f, expectedIdentifier: e.target.value })} placeholder="used only to flag wrong-account on verify" /></div>
        {!account && (
          <div>
            <label className={labelCls}>Cookie bundle (JSON or "name=value; …")</label>
            <textarea rows={5} className={`${field} font-mono text-xs resize-none`} value={f.sessionBundle} onChange={e => setF({ ...f, sessionBundle: e.target.value })}
              placeholder='{"cookies":[{"name":"session","value":"…"}]}' />
            <p className="text-[11px] text-genz-muted mt-1">Encrypted at rest. Never shown again. You can also use “Capture via proxy” after creating.</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div><label className={labelCls}>Status</label><select className={field} value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>{ACCOUNT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
          <div><label className={labelCls}>Priority</label><input type="number" className={field} value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm text-genz-navy"><input type="checkbox" checked={f.isPrimary} onChange={e => setF({ ...f, isPrimary: e.target.checked })} /> Set as primary</label>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} className="px-4 py-2 text-sm text-genz-muted hover:text-genz-navy">Cancel</button>
        <button onClick={submit} className="btn-grad inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold"><Save size={15} /> Save</button>
      </div>
    </Shell>
  );
};

const SessionModal = ({ account, onClose, onSave }) => {
  const [bundle, setBundle] = useState('');
  return (
    <Shell title={`Update cookies — ${account.label}`} onClose={onClose}>
      <label className={labelCls}>Cookie bundle (JSON or "name=value; …")</label>
      <textarea rows={7} className={`${field} font-mono text-xs resize-none`} value={bundle} onChange={e => setBundle(e.target.value)}
        placeholder='{"cookies":[{"name":"session","value":"…"}],"localStorage":{}}' />
      <p className="text-[11px] text-genz-muted mt-1">Encrypted at rest and never returned. Replaces the stored session.</p>
      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} className="px-4 py-2 text-sm text-genz-muted hover:text-genz-navy">Cancel</button>
        <button onClick={() => bundle.trim() && onSave(account.id, bundle.trim())} className="btn-grad inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold"><Save size={15} /> Save cookies</button>
      </div>
    </Shell>
  );
};

const ClientModal = ({ client, crmClients, existing, onClose, onSave }) => {
  const [f, setF] = useState({
    userId: client?.userId || '', planName: client?.planName || '', expiryDate: toDateInput(client?.expiryDate), status: client?.status || 'active',
  });
  const taken = new Set((existing || []).map(c => String(c.userId)));
  const options = (crmClients || []).filter(c => client || !taken.has(String(c._id)));
  const submit = () => {
    if (!client && !f.userId) return;
    onSave({ userId: f.userId, planName: f.planName, expiryDate: f.expiryDate || null, status: f.status });
  };
  return (
    <Shell title={client ? 'Edit access' : 'Grant access'} onClose={onClose}>
      <div className="space-y-3">
        {client ? (
          <p className="text-sm text-genz-navy font-semibold">{client.user?.fullName} <span className="text-genz-muted font-normal">{client.user?.email}</span></p>
        ) : (
          <div><label className={labelCls}>Client</label>
            <select className={field} value={f.userId} onChange={e => setF({ ...f, userId: e.target.value })}>
              <option value="">Select a client…</option>
              {options.map(c => <option key={c._id} value={c._id}>{c.fullName} — {c.email}</option>)}
            </select>
          </div>
        )}
        <div><label className={labelCls}>Plan name (optional)</label><input className={field} value={f.planName} onChange={e => setF({ ...f, planName: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={labelCls}>Expiry (optional)</label><input type="date" className={field} value={f.expiryDate} onChange={e => setF({ ...f, expiryDate: e.target.value })} /></div>
          <div><label className={labelCls}>Status</label><select className={field} value={f.status} onChange={e => setF({ ...f, status: e.target.value })}><option value="active">active</option><option value="disabled">disabled</option></select></div>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} className="px-4 py-2 text-sm text-genz-muted hover:text-genz-navy">Cancel</button>
        <button onClick={submit} className="btn-grad inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold"><CheckCircle2 size={15} /> Save</button>
      </div>
    </Shell>
  );
};

export default AdminProxyTools;
