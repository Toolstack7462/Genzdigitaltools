import { useState, useEffect, useCallback, useMemo } from 'react';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import {
  Sparkles, Plus, RefreshCw, Trash2, Edit2, ShieldOff, Clock,
  Loader2, X, Save, Eye, Settings as SettingsIcon, Users, Zap,
  KeyRound, Star, CheckCircle2, AlertOctagon, ShieldCheck, List, Globe, Search, Pin
} from 'lucide-react';
import { stealthAdmin } from '../../services/stealthService';
import { cachedGet } from '../../services/apiCache';
import { useToast } from '../../components/Toast';
import ClientSearchSelect from '../../components/admin/ClientSearchSelect';
import ListFilterBar from '../../components/admin/ListFilterBar';

// ── Lightweight client-side filters (lists are capped at 100 rows) ──────────────
const ACCOUNT_FILTERS = [
  { key: 'all', label: 'All' }, { key: 'active', label: 'Active' }, { key: 'standby', label: 'Standby' },
  { key: 'session_expired', label: 'Session expired' }, { key: 'limit_reached', label: 'Limit reached' },
  { key: 'blocked', label: 'Blocked' }, { key: 'working', label: 'Working' }, { key: 'needs_login', label: 'Needs login' },
  { key: 'has_sessions', label: 'Has sessions' }, { key: 'zero_sessions', label: 'Zero sessions' }, { key: 'primary', label: 'Primary' },
];
const CLIENT_FILTERS = [
  { key: 'all', label: 'All' }, { key: 'active', label: 'Active' }, { key: 'disabled', label: 'Disabled' },
  { key: 'expired', label: 'Expired' }, { key: 'limit_reached', label: 'Limit reached' },
  { key: 'has_sessions', label: 'Has sessions' }, { key: 'zero_sessions', label: 'Zero sessions' },
];
function acctMatchesFilter(a, key) {
  switch (key) {
    case 'active': case 'standby': case 'session_expired': case 'limit_reached': case 'blocked': return a.status === key;
    case 'working': return a.available !== false && !!a.hasSessionCookie;
    case 'needs_login': return a.available === false || !a.hasSessionCookie;
    case 'has_sessions': return (a.activeLeaseCount || 0) > 0;
    case 'zero_sessions': return !(a.activeLeaseCount || 0);
    case 'primary': return !!a.isPrimary;
    default: return true;
  }
}
function acctMatchesSearch(a, q) {
  if (!q) return true;
  return [a.label, a.status, a.maskedIdentifier, a.verification?.result].filter(Boolean).join(' ').toLowerCase().includes(q);
}
function cliLimitReached(c) {
  const h = c.limits?.humanizer, d = c.limits?.detector;
  return (typeof h === 'number' && h >= 0 && (c.remaining?.humanizer ?? 1) <= 0)
      || (typeof d === 'number' && d >= 0 && (c.remaining?.detector ?? 1) <= 0);
}
function cliMatchesFilter(c, key) {
  switch (key) {
    case 'active': return c.status === 'active' && !c.expired;
    case 'disabled': return c.status === 'disabled';
    case 'expired': return !!c.expired;
    case 'limit_reached': return cliLimitReached(c);
    case 'has_sessions': return (c.activeLeaseCount || 0) > 0;
    case 'zero_sessions': return !(c.activeLeaseCount || 0);
    default: return true;
  }
}
function cliMatchesSearch(c, q) {
  if (!q) return true;
  return [c.user?.fullName, c.user?.email, c.planName, c.status].filter(Boolean).join(' ').toLowerCase().includes(q);
}
const NoMatchBox = ({ onClear }) => (
  <div className="p-8 text-center">
    <Search size={24} className="mx-auto mb-2 text-slate-400" />
    <p className="text-sm font-semibold text-slate-700">No matches</p>
    <button onClick={onClear} className="text-xs text-genz-teal hover:underline mt-1">Clear filters</button>
  </div>
);

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
  const [crmLoading, setCrmLoading] = useState(false);
  const [crmSearching, setCrmSearching] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [refreshAccount, setRefreshAccount] = useState(null);
  const [leasesAccount, setLeasesAccount] = useState(null);
  const [verifyingId, setVerifyingId] = useState(null);
  const [acctSearch, setAcctSearch] = useState(''); const [acctFilter, setAcctFilter] = useState('all');
  const [cliSearch, setCliSearch] = useState(''); const [cliFilter, setCliFilter] = useState('all');

  const filteredAccounts = useMemo(() => {
    const q = acctSearch.trim().toLowerCase();
    return accounts.filter(a => acctMatchesFilter(a, acctFilter) && acctMatchesSearch(a, q));
  }, [accounts, acctSearch, acctFilter]);
  const filteredClients = useMemo(() => {
    const q = cliSearch.trim().toLowerCase();
    return clients.filter(c => cliMatchesFilter(c, cliFilter) && cliMatchesSearch(c, q));
  }, [clients, cliSearch, cliFilter]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [s, st, cl, ac] = await Promise.all([
        stealthAdmin.getSettings(), stealthAdmin.getStats(), stealthAdmin.listClients({ limit: 100 }),
        stealthAdmin.listAccounts(),
      ]);
      setSettings(s.data.settings);
      setStats(st.data.stats);
      setClients(cl.data.clients || []);
      setAccounts(ac.data.accounts || []);
    } catch (e) {
      showError(e.response?.data?.error || 'Failed to load StealthWriter module');
    } finally { setLoading(false); }
  }, [showError]);

  useEffect(() => { load(); }, [load]);

  // Doubles as the picker's server-side search: no term → first 100 (cached);
  // a term queries the DB by name OR email so every client is reachable.
  const loadCrmClients = async (term = '') => {
    try {
      term ? setCrmSearching(true) : setCrmLoading(true);
      const params = new URLSearchParams({ limit: '100' });
      if (term && term.trim()) params.append('search', term.trim());
      const data = await cachedGet(`/admin/clients?${params}`);
      setCrmClients(data.clients || []);
    } catch { /* non-fatal */ }
    finally { term ? setCrmSearching(false) : setCrmLoading(false); }
  };

  const saveSettings = async () => {
    try {
      const res = await stealthAdmin.updateSettings({
        leaseDurationMinutes: Number(settings.leaseDurationMinutes),
        fixedLeaseEnabled: !!settings.fixedLeaseEnabled,
        maxSessionMinutes: Number(settings.maxSessionMinutes),
        accountSelectionMode: settings.accountSelectionMode,
      });
      setSettings(res.data.settings);
      showSuccess('Settings saved');
    } catch (e) { showError(e.response?.data?.error || 'Failed to save settings'); }
  };

  const doAction = async (fn, msg) => {
    try { await fn(); showSuccess(msg); load(); }
    catch (e) { showError(e.response?.data?.error || 'Action failed'); }
  };

  const verify = async (a) => {
    try {
      setVerifyingId(a.id);
      const res = await stealthAdmin.verifyAccount(a.id);
      const result = (res.data?.result || res.data?.account?.verification?.result || '').replace('_', ' ');
      showSuccess(`Verify "${a.label}": ${result || 'done'}`);
      load();
    } catch (e) { showError(e.response?.data?.error || 'Verify failed'); }
    finally { setVerifyingId(null); }
  };

  const refreshThroughProxy = async (a) => {
    try {
      const res = await stealthAdmin.captureLease(a.id);
      if (res.data?.url) {
        window.open(res.data.url, '_blank', 'noopener');
        showSuccess(`Capture tab opened for "${a.label}". Log in, then click "Save session to vault".`);
      }
    } catch (e) { showError(e.response?.data?.error || 'Failed to start capture'); }
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
                <label className="text-sm sm:col-span-2">
                  <span className="block text-slate-600 mb-1">Account selection mode</span>
                  <select value={settings.accountSelectionMode || 'auto_failover'}
                    onChange={(e) => setSettings({ ...settings, accountSelectionMode: e.target.value })}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2">
                    <option value="manual_primary">Manual Primary (no failover)</option>
                    <option value="auto_failover">Manual Primary + Auto Failover (recommended)</option>
                    <option value="round_robin">Round Robin</option>
                    <option value="least_used">Least Used</option>
                  </select>
                </label>
              </div>
              <p className="text-[12px] text-slate-400 mt-2">Even with fixed lease off, the backend still validates status, expiry and usage limits on every action. Account selection applies to new leases only.</p>
              <button onClick={saveSettings} className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-slate-800 hover:bg-slate-700"><Save size={15} /> Save settings</button>
            </div>
          )}

          {/* Account Vault */}
          <div className="ds-card rounded-xl overflow-hidden mb-5">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <KeyRound size={16} className="text-violet-500" />
                <h2 className="font-semibold text-slate-700">StealthWriter Accounts (Cookies)</h2>
                <span className="text-[11px] text-slate-400">— multiple cookie-based accounts, encrypted at rest</span>
              </div>
              <button onClick={() => setShowAddAccount(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-r from-violet-600 to-fuchsia-500">
                <Plus size={15} /> Add account
              </button>
            </div>
            {accounts.length > 0 && (
              <div className="px-4 py-3 border-b border-slate-100">
                <ListFilterBar
                  search={acctSearch} onSearch={setAcctSearch} placeholder="Search accounts by label, status, or login…"
                  options={ACCOUNT_FILTERS} value={acctFilter} onChange={setAcctFilter}
                  resultText={`Showing ${filteredAccounts.length} of ${accounts.length}`} />
              </div>
            )}
            {accounts.length === 0 ? (
              <p className="p-8 text-center text-slate-400 text-sm">No accounts yet. Add your StealthWriter account session to start.</p>
            ) : filteredAccounts.length === 0 ? (
              <NoMatchBox onClear={() => { setAcctSearch(''); setAcctFilter('all'); }} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-slate-500 border-b border-slate-100">
                    <th className="px-4 py-2 font-medium">Account</th><th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Session</th><th className="px-4 py-2 font-medium">Usage</th>
                    <th className="px-4 py-2 font-medium">Active leases</th><th className="px-4 py-2 font-medium text-right">Actions</th>
                  </tr></thead>
                  <tbody>
                    {filteredAccounts.map((a) => (
                      <tr key={a.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5 font-medium text-slate-700">
                            {a.isPrimary && <Star size={13} className="text-amber-400 fill-amber-400" title="Primary" />}
                            {a.label}
                          </div>
                          <div className="text-[11px] text-slate-400">priority {a.priority}{a.maskedIdentifier ? ` · ${a.maskedIdentifier}` : ''}</div>
                          {a.verification?.result && (
                            <div className="text-[11px] mt-0.5"><VerifyBadge result={a.verification.result} /> <span className="text-slate-400">{a.verification.checkedAt ? new Date(a.verification.checkedAt).toLocaleDateString() : ''}</span></div>
                          )}
                        </td>
                        <td className="px-4 py-2.5"><AccountStatusBadge status={a.status} /></td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {a.hasSessionCookie
                            ? <span className="text-[12px] text-green-700">✓ session cookie</span>
                            : <span className="text-[12px] text-amber-600">⚠ no session cookie</span>}
                          {a.sessionStatus && <div className="text-[10px] text-slate-400 mt-0.5">{String(a.sessionStatus).replace('_', ' ')}</div>}
                          {a.available === false && a.unavailableReason && <div className="text-[10px] text-red-500 mt-0.5">unavailable: {String(a.unavailableReason).replace(/_/g, ' ')}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{a.usageCount} leases</td>
                        <td className="px-4 py-2.5 text-slate-600">{a.activeLeaseCount}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1.5 text-slate-400">
                            <button title="Verify cookies" disabled={verifyingId === a.id} onClick={() => verify(a)} className="hover:text-green-600 disabled:opacity-50">
                              {verifyingId === a.id ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                            </button>
                            <button title="View leases using this account" onClick={() => setLeasesAccount(a)} className="hover:text-blue-600"><List size={16} /></button>
                            <button title="Refresh cookies (paste bundle)" onClick={() => setRefreshAccount(a)} className="hover:text-blue-600"><RefreshCw size={16} /></button>
                            <button title="Refresh cookies through proxy (log in via stealth1)" onClick={() => refreshThroughProxy(a)} className="hover:text-violet-600"><Globe size={16} /></button>
                            <button title="Set as primary" onClick={() => doAction(() => stealthAdmin.setAccountPrimary(a.id), 'Primary set')} className="hover:text-amber-500"><Star size={16} /></button>
                            {a.status !== 'limit_reached'
                              ? <button title="Mark limit reached" onClick={() => doAction(() => stealthAdmin.setAccountStatus(a.id, 'limit_reached'), 'Marked limit reached')} className="hover:text-orange-600"><AlertOctagon size={16} /></button>
                              : <button title="Mark active" onClick={() => doAction(() => stealthAdmin.setAccountStatus(a.id, 'active'), 'Marked active')} className="hover:text-green-600"><CheckCircle2 size={16} /></button>}
                            <button title="Revoke active leases" onClick={() => window.confirm(`Revoke active leases using "${a.label}"?`) && doAction(() => stealthAdmin.revokeAccountLeases(a.id), 'Leases revoked')} className="hover:text-orange-600"><ShieldOff size={16} /></button>
                            <button title="Delete account" onClick={() => window.confirm(`Delete account "${a.label}"? Active leases on it will be revoked.`) && doAction(() => stealthAdmin.deleteAccount(a.id), 'Account deleted')} className="hover:text-red-600"><Trash2 size={16} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Clients table */}
          <div className="ds-card rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <h2 className="font-semibold text-slate-700">StealthWriter clients</h2>
              <button onClick={load} className="text-slate-400 hover:text-slate-600"><RefreshCw size={16} /></button>
            </div>
            {clients.length > 0 && (
              <div className="px-4 py-3 border-b border-slate-100">
                <ListFilterBar
                  search={cliSearch} onSearch={setCliSearch} placeholder="Search clients by name, email, plan, or status…"
                  options={CLIENT_FILTERS} value={cliFilter} onChange={setCliFilter}
                  resultText={`Showing ${filteredClients.length} of ${clients.length}`} />
              </div>
            )}
            {clients.length === 0 ? (
              <p className="p-8 text-center text-slate-400 text-sm">No StealthWriter clients yet.</p>
            ) : filteredClients.length === 0 ? (
              <NoMatchBox onClear={() => { setCliSearch(''); setCliFilter('all'); }} />
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
                    {filteredClients.map((c) => (
                      <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-700">{c.user?.fullName || '—'}</div>
                          <div className="text-[12px] text-slate-400">{c.user?.email || c.userId}</div>
                          {c.accountPin && c.accountPin.mode !== 'auto' && c.accountPin.accountLabel && (
                            <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-500">
                              <Pin size={11} className="text-blue-500" />
                              <span className="font-medium text-slate-600">{c.accountPin.accountLabel}</span>
                              <HealthBadge health={c.accountPin.accountHealth} />
                            </div>
                          )}
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

      {showCreate && <CreateModal crmClients={crmClients} crmLoading={crmLoading} crmSearching={crmSearching} onSearchClients={loadCrmClients} onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); load(); }} showError={showError} showSuccess={showSuccess} />}
      {editing && <EditModal client={editing} accounts={accounts} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }} showError={showError} showSuccess={showSuccess} />}
      {detail && <DetailModal detail={detail} onClose={() => setDetail(null)} onRevokeLease={async (lid) => { await stealthAdmin.revokeLease(lid); const r = await stealthAdmin.getClient(detail.client.id); setDetail(r.data); }} />}
      {showAddAccount && <AccountModal onClose={() => setShowAddAccount(false)}
        onSaved={() => { setShowAddAccount(false); load(); }} showError={showError} showSuccess={showSuccess} />}
      {refreshAccount && <RefreshSessionModal account={refreshAccount} onClose={() => setRefreshAccount(null)}
        onSaved={() => { setRefreshAccount(null); load(); }} showError={showError} showSuccess={showSuccess} />}
      {leasesAccount && <AccountLeasesModal account={leasesAccount} onClose={() => setLeasesAccount(null)}
        showError={showError} showSuccess={showSuccess} onChanged={load} />}
    </AdminLayoutEnhanced>
  );
};

// ── Verification result badge ───────────────────────────────────────────────
const VERIFY_STYLES = {
  working: 'bg-green-100 text-green-700',
  session_expired: 'bg-amber-100 text-amber-700',
  limit_reached: 'bg-orange-100 text-orange-700',
  wrong_account: 'bg-red-100 text-red-700',
  blocked: 'bg-red-100 text-red-700',
};
const VerifyBadge = ({ result }) => (
  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${VERIFY_STYLES[result] || 'bg-slate-100 text-slate-600'}`}>
    {String(result || '').replace('_', ' ')}
  </span>
);

// ── Account status badge ────────────────────────────────────────────────────
const STATUS_STYLES = {
  active: 'bg-green-100 text-green-700',
  standby: 'bg-slate-100 text-slate-600',
  limit_reached: 'bg-orange-100 text-orange-700',
  session_expired: 'bg-amber-100 text-amber-700',
  blocked: 'bg-red-100 text-red-700',
};
const AccountStatusBadge = ({ status }) => (
  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${STATUS_STYLES[status] || 'bg-slate-100 text-slate-600'}`}>
    {String(status || '').replace('_', ' ')}
  </span>
);

// ── Account health badge (working / needs login / expired / blocked / limit) ──
const HEALTH_STYLES = {
  working: 'bg-green-100 text-green-700',
  needs_login: 'bg-amber-100 text-amber-700',
  expired: 'bg-amber-100 text-amber-700',
  limit_reached: 'bg-orange-100 text-orange-700',
  blocked: 'bg-red-100 text-red-700',
  needs_verification: 'bg-slate-100 text-slate-600',
  missing: 'bg-red-100 text-red-700',
};
const HEALTH_LABEL = {
  working: 'working', needs_login: 'needs login', expired: 'expired',
  limit_reached: 'limit reached', blocked: 'blocked',
  needs_verification: 'unverified', missing: 'missing',
};
const HealthBadge = ({ health }) => !health ? null : (
  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${HEALTH_STYLES[health] || 'bg-slate-100 text-slate-600'}`}>
    {HEALTH_LABEL[health] || String(health).replace(/_/g, ' ')}
  </span>
);
const PIN_MODE_LABEL = {
  auto: 'Auto / default pool',
  specific: 'Specific account only',
  specific_or_auto: 'Specific + fallback to pool',
};

const BUNDLE_PLACEHOLDER = `{
  "cookies": [{ "name": "session", "value": "..." }],
  "localStorage": { "token": "..." }
}`;

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

const CreateModal = ({ crmClients, crmLoading, crmSearching, onSearchClients, onClose, onCreated, showError, showSuccess }) => {
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
        <ClientSearchSelect
          id="sw-crm-client"
          clients={crmClients}
          value={form.userId}
          onChange={(id) => setForm({ ...form, userId: id })}
          loading={crmLoading}
          onSearch={onSearchClients}
          searching={crmSearching}
          placeholder="Search client by name or email…"
        />
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

const EditModal = ({ client, accounts = [], onClose, onSaved, showError, showSuccess }) => {
  const pin = client.accountPin || { mode: 'auto', accountId: null, accountLabel: null, accountHealth: null };
  const [form, setForm] = useState({
    planName: client.planName, dailyHumanizerLimit: client.limits.humanizer, dailyDetectorLimit: client.limits.detector,
    expiryDate: toDateInput(client.expiryDate), status: client.status,
    pinMode: pin.mode || 'auto', pinnedAccountId: pin.accountId || '',
  });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (form.pinMode !== 'auto' && !form.pinnedAccountId) return showError('Select an account to pin, or choose Auto mode');
    try {
      setSaving(true);
      await stealthAdmin.updateClient(client.id, {
        planName: form.planName, dailyHumanizerLimit: Number(form.dailyHumanizerLimit), dailyDetectorLimit: Number(form.dailyDetectorLimit),
        expiryDate: form.expiryDate || null, status: form.status,
        accountPinMode: form.pinMode,
        pinnedAccountId: form.pinMode === 'auto' ? null : (form.pinnedAccountId || null),
      });
      showSuccess('Client updated'); onSaved();
    } catch (e) { showError(e.response?.data?.error || 'Failed to update'); } finally { setSaving(false); }
  };
  const clearPin = () => setForm({ ...form, pinMode: 'auto', pinnedAccountId: '' });
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

      {/* ── StealthWriter account assignment (optional pinning) ── */}
      <div className="mt-1 mb-3 border-t border-slate-100 pt-3">
        <div className="flex items-center justify-between mb-1">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700"><Pin size={14} /> StealthWriter account assignment</span>
          {form.pinMode !== 'auto' && (
            <button type="button" onClick={clearPin} className="text-[12px] text-blue-600 hover:underline">Clear → Auto</button>
          )}
        </div>
        <p className="text-[12px] text-slate-400 mb-2">
          Default is the automatic pool. Pin a client to one of your saved accounts only when needed — official limits, logins and abuse protections still apply, and account sessions/cookies stay backend-only.
        </p>
        <Field label="Assignment mode">
          <select className={inputCls} value={form.pinMode} onChange={(e) => setForm({ ...form, pinMode: e.target.value })}>
            <option value="auto">Auto / Default pool</option>
            <option value="specific">Specific account only</option>
            <option value="specific_or_auto">Specific account, fallback to pool</option>
          </select>
        </Field>
        {form.pinMode !== 'auto' && (
          accounts.length === 0 ? (
            <p className="text-[12px] text-amber-600 mb-2">No saved StealthWriter accounts yet. Add one in the Account Vault above first.</p>
          ) : (
            <Field label="Preferred account">
              <select className={inputCls} value={form.pinnedAccountId} onChange={(e) => setForm({ ...form, pinnedAccountId: e.target.value })}>
                <option value="">— Select an account —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} — {HEALTH_LABEL[a.health] || a.status}{a.isPrimary ? ' · primary' : ''}
                  </option>
                ))}
              </select>
            </Field>
          )
        )}
        {pin.mode !== 'auto' && pin.accountId && (
          <div className="text-[12px] text-slate-500 flex items-center gap-2 mt-1">
            <span>Currently assigned:</span>
            <b className="text-slate-700">{pin.accountLabel || 'account'}</b>
            <HealthBadge health={pin.accountHealth} />
            <span className="text-slate-400">· {PIN_MODE_LABEL[pin.mode] || pin.mode}</span>
          </div>
        )}
      </div>

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
          <thead><tr className="text-left text-slate-500 border-b"><th className="py-1.5 pr-2">Issued</th><th className="py-1.5 pr-2">Expires</th><th className="py-1.5 pr-2">Account</th><th className="py-1.5 pr-2">State</th><th className="py-1.5 text-right">—</th></tr></thead>
          <tbody>{leases.map((l) => (
            <tr key={l.id} className="border-b border-slate-50">
              <td className="py-1.5 pr-2 text-slate-600">{fmtDate(l.issuedAt)}</td>
              <td className="py-1.5 pr-2 text-slate-600">{fmtDate(l.expiresAt)}</td>
              <td className="py-1.5 pr-2 text-slate-500">{l.accountLabel || '—'}</td>
              <td className="py-1.5 pr-2">{l.revoked ? <span className="text-red-600">revoked</span> : l.active ? <span className="text-green-600">active</span> : <span className="text-slate-400">expired</span>}</td>
              <td className="py-1.5 text-right">{l.active && !l.revoked && <button onClick={() => onRevokeLease(l.id)} className="text-orange-600 hover:underline">revoke</button>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      <h4 className="font-semibold text-slate-700 mb-2 text-sm">Recent usage</h4>
      {usageLogs.length === 0 ? <p className="text-sm text-slate-400">No usage yet.</p> : (
        <div className="overflow-x-auto max-h-64"><table className="w-full text-[12.5px]">
          <thead><tr className="text-left text-slate-500 border-b"><th className="py-1.5 pr-2">Time</th><th className="py-1.5 pr-2">Action</th><th className="py-1.5 pr-2">Account</th><th className="py-1.5 pr-2">Result</th><th className="py-1.5">Reason</th></tr></thead>
          <tbody>{usageLogs.map((u) => (
            <tr key={u._id} className="border-b border-slate-50">
              <td className="py-1.5 pr-2 text-slate-600">{fmtDate(u.createdAt)}</td>
              <td className="py-1.5 pr-2 text-slate-600">{u.action}</td>
              <td className="py-1.5 pr-2 text-slate-500">{u.accountLabel || '—'}</td>
              <td className="py-1.5 pr-2">{u.allowed ? <span className="text-green-600">allowed</span> : <span className="text-red-600">blocked</span>}</td>
              <td className="py-1.5 text-slate-500">{u.reason}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Modal>
  );
};

// ── Account Vault modals ────────────────────────────────────────────────────
const AccountModal = ({ onClose, onSaved, showError, showSuccess }) => {
  const [form, setForm] = useState({ label: '', sessionBundle: '', expectedIdentifier: '', status: 'active', priority: 100, isPrimary: false });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!form.label.trim()) return showError('Label is required');
    try {
      setSaving(true);
      await stealthAdmin.createAccount({
        label: form.label.trim(),
        sessionBundle: form.sessionBundle.trim() || null,
        expectedIdentifier: form.expectedIdentifier.trim() || null,
        status: form.status, priority: Number(form.priority), isPrimary: form.isPrimary,
      });
      showSuccess('Account added'); onSaved();
    } catch (e) { showError(e.response?.data?.error || 'Failed to add account'); } finally { setSaving(false); }
  };
  return (
    <Modal title="Add StealthWriter account" onClose={onClose}>
      <Field label="Label (internal name)"><input className={inputCls} value={form.label} placeholder="e.g. SW Main #1" onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
      <Field label="Cookie bundle (JSON — cookies, optional localStorage). Encrypted at rest; never shown again.">
        <textarea className={`${inputCls} font-mono text-[12px]`} rows={6} placeholder={BUNDLE_PLACEHOLDER}
          value={form.sessionBundle} onChange={(e) => setForm({ ...form, sessionBundle: e.target.value })} />
      </Field>
      <Field label="Expected login email (optional — used only to flag 'wrong account' on verify; shown masked)">
        <input className={inputCls} value={form.expectedIdentifier} placeholder="name@example.com"
          onChange={(e) => setForm({ ...form, expectedIdentifier: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <select className={inputCls} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="active">active</option><option value="standby">standby</option>
            <option value="limit_reached">limit_reached</option><option value="session_expired">session_expired</option><option value="blocked">blocked</option>
          </select>
        </Field>
        <Field label="Priority (lower = preferred)"><input type="number" className={inputCls} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm mb-3">
        <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} />
        <span className="text-slate-600">Set as primary</span>
      </label>
      <button onClick={submit} disabled={saving} className="w-full mt-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold text-white bg-gradient-to-r from-violet-600 to-fuchsia-500 disabled:opacity-60">
        {saving ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />} Add account
      </button>
    </Modal>
  );
};

const RefreshSessionModal = ({ account, onClose, onSaved, showError, showSuccess }) => {
  const [bundle, setBundle] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!bundle.trim()) return showError('Paste the new session bundle');
    try {
      setSaving(true);
      await stealthAdmin.refreshAccountSession(account.id, bundle.trim());
      showSuccess('Session refreshed'); onSaved();
    } catch (e) { showError(e.response?.data?.error || 'Failed to refresh session'); } finally { setSaving(false); }
  };
  return (
    <Modal title={`Refresh session — ${account.label}`} onClose={onClose}>
      <p className="text-[12.5px] text-slate-500 mb-3">Paste the account's current session bundle. It is encrypted at rest and never displayed again. Refreshing clears a <b>session_expired</b> state.</p>
      <Field label="Session bundle (JSON)">
        <textarea className={`${inputCls} font-mono text-[12px]`} rows={7} placeholder={BUNDLE_PLACEHOLDER}
          value={bundle} onChange={(e) => setBundle(e.target.value)} />
      </Field>
      <button onClick={submit} disabled={saving} className="w-full mt-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold text-white bg-blue-600 disabled:opacity-60">
        {saving ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />} Refresh session
      </button>
    </Modal>
  );
};

const AccountLeasesModal = ({ account, onClose, showError, showSuccess, onChanged }) => {
  const [loading, setLoading] = useState(true);
  const [leases, setLeases] = useState([]);
  useEffect(() => {
    (async () => {
      try { const r = await stealthAdmin.accountLeases(account.id); setLeases(r.data.leases || []); }
      catch (e) { showError(e.response?.data?.error || 'Failed to load leases'); }
      finally { setLoading(false); }
    })();
  }, [account.id, showError]);
  const revokeAll = async () => {
    if (!window.confirm(`Revoke all active leases using "${account.label}"?`)) return;
    try { await stealthAdmin.revokeAccountLeases(account.id); showSuccess('Active leases revoked'); onChanged && onChanged(); onClose(); }
    catch (e) { showError(e.response?.data?.error || 'Failed to revoke leases'); }
  };
  const activeCount = leases.filter(l => l.active).length;
  return (
    <Modal title={`Leases — ${account.label}`} onClose={onClose} wide>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[13px] text-slate-500">{activeCount} active · {leases.length} recent (showing latest 50)</p>
        {activeCount > 0 && (
          <button onClick={revokeAll} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold text-white bg-orange-600 hover:bg-orange-500">
            <ShieldOff size={14} /> Revoke active leases
          </button>
        )}
      </div>
      {loading ? <div className="py-10 text-center text-slate-400"><Loader2 className="animate-spin inline" size={18} /></div>
        : leases.length === 0 ? <p className="text-sm text-slate-400 py-6 text-center">No leases have used this account.</p> : (
        <div className="overflow-x-auto max-h-80"><table className="w-full text-[12.5px]">
          <thead><tr className="text-left text-slate-500 border-b"><th className="py-1.5 pr-2">Client</th><th className="py-1.5 pr-2">Issued</th><th className="py-1.5 pr-2">Expires</th><th className="py-1.5">State</th></tr></thead>
          <tbody>{leases.map((l) => (
            <tr key={l.id} className="border-b border-slate-50">
              <td className="py-1.5 pr-2 text-slate-600">{l.client || '—'}</td>
              <td className="py-1.5 pr-2 text-slate-600">{fmtDate(l.issuedAt)}</td>
              <td className="py-1.5 pr-2 text-slate-600">{fmtDate(l.expiresAt)}</td>
              <td className="py-1.5">{l.revoked ? <span className="text-red-600">revoked</span> : l.active ? <span className="text-green-600">active</span> : <span className="text-slate-400">expired</span>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Modal>
  );
};

export default AdminStealthWriter;
