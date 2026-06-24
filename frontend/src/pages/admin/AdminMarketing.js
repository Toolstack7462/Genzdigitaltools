import { useState, useEffect, useCallback } from 'react';
import AdminLayoutEnhanced, { ADMIN_CARD_VARIANTS } from '../../components/AdminLayoutEnhanced';
import {
  Megaphone, Plus, Trash2, Loader2, X, Save, Eye, EyeOff, Mail, MessageCircle,
  Tag, Package, Users, User, Send, Gift,
} from 'lucide-react';
import api from '../../services/api';
import { cachedGet } from '../../services/apiCache';
import { useToast } from '../../components/Toast';
import ClientSearchSelect from '../../components/admin/ClientSearchSelect';
import WhatsAppSendDialog from '../../components/admin/WhatsAppSendDialog';
import { buildOfferMessage } from '../../components/admin/whatsappTemplates';

const KINDS = [
  { key: 'combo', label: 'Combo deal' },
  { key: 'renewal', label: 'Renewal discount' },
  { key: 'upgrade', label: 'Upgrade offer' },
  { key: 'recovery', label: 'Expired recovery' },
];
const kindLabel = (k) => (KINDS.find(x => x.key === k)?.label || 'Offer');
const KIND_CLS = {
  combo: 'bg-blue-50 text-blue-700 border-blue-200',
  renewal: 'bg-amber-50 text-amber-700 border-amber-200',
  upgrade: 'bg-violet-50 text-violet-700 border-violet-200',
  recovery: 'bg-red-50 text-red-700 border-red-200',
};
const fmtDate = (d) => { if (!d) return null; const dt = new Date(d); return isNaN(dt.getTime()) ? null : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
const toDateInput = (d) => { if (!d) return ''; const dt = new Date(d); return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10); };

const AdminMarketing = () => {
  const { showSuccess, showError, showWarning } = useToast();
  const [offers, setOffers] = useState([]);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [tools, setTools] = useState([]);
  const [crmClients, setCrmClients] = useState([]);
  const [crmLoading, setCrmLoading] = useState(true);
  const [crmSearching, setCrmSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // offer object or {} for new
  const [sendOffer, setSendOffer] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await api.get('/admin/offers');
      setOffers(r.data?.offers || []);
      setEmailEnabled(r.data?.emailEnabled !== false);
    } catch (_) { showError('Failed to load offers'); }
    finally { setLoading(false); }
  }, [showError]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/admin/tools').then(r => setTools(r.data?.tools || [])).catch(() => {});
    cachedGet('/admin/clients?limit=100').then(d => setCrmClients(d?.clients || [])).catch(() => {}).finally(() => setCrmLoading(false));
  }, []);

  const searchCrmClients = useCallback(async (term) => {
    try {
      setCrmSearching(true);
      const params = new URLSearchParams({ limit: '100' });
      if (term && term.trim()) params.append('search', term.trim());
      const d = await cachedGet(`/admin/clients?${params}`);
      setCrmClients(d?.clients || []);
    } catch (_) { /* keep list */ } finally { setCrmSearching(false); }
  }, []);

  const saveOffer = async (form) => {
    try {
      if (form._id) await api.patch(`/admin/offers/${form._id}`, form);
      else await api.post('/admin/offers', form);
      showSuccess('Offer saved'); setEditing(null); load();
    } catch (e) { showError(e.response?.data?.error || 'Failed to save offer'); }
  };
  const toggle = async (o, field) => {
    try { await api.patch(`/admin/offers/${o._id}`, { [field]: !o[field] }); setOffers(list => list.map(x => x._id === o._id ? { ...x, [field]: !o[field] } : x)); }
    catch (_) { showError('Failed to update'); }
  };
  const remove = async (o) => {
    if (!window.confirm('Delete this offer?')) return;
    try { await api.delete(`/admin/offers/${o._id}`); setOffers(list => list.filter(x => x._id !== o._id)); }
    catch (_) { showError('Failed to delete'); }
  };

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-5xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-extrabold text-genz-navy flex items-center gap-2.5">
              <span className="ds-icon-grad w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"><Megaphone size={18} /></span>
              Marketing &amp; Offers
            </h1>
            <p className="text-sm text-genz-muted mt-0.5">Promote combo deals, renewals, and upgrades. Send by WhatsApp/email or show as a card on a client's dashboard. <span className="text-genz-muted/80">Per-client renewal discounts &amp; bonus days live in <b>Renewals</b>.</span></p>
          </div>
          <button onClick={() => setEditing({})} className="btn-grad inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-bold flex-shrink-0">
            <Plus size={15} /> New offer
          </button>
        </div>

        {!emailEnabled && (
          <p className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">Email isn't configured on the server — offers can still be sent via WhatsApp.</p>
        )}

        {loading ? (
          <div className="space-y-2.5" aria-busy="true">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-genz-navy/5 animate-pulse" />)}</div>
        ) : offers.length === 0 ? (
          <div className={`${ADMIN_CARD_VARIANTS.elevated} rounded-2xl p-12 text-center`}>
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-500/15 to-cyan-500/15 flex items-center justify-center"><Gift size={28} className="text-genz-blue" /></div>
            <h3 className="text-lg font-bold text-genz-navy mb-1">No offers yet</h3>
            <p className="text-sm text-genz-muted">Create a combo deal or promo, then send it or show it on a client's dashboard.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {offers.map(o => (
              <div key={o._id} className={`${ADMIN_CARD_VARIANTS.default} rounded-2xl p-4 ${o.active ? '' : 'opacity-70'}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-genz-navy truncate">{o.title}</p>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${KIND_CLS[o.kind] || KIND_CLS.combo}`}>{kindLabel(o.kind)}</span>
                      <span className={`ds-badge ${o.active ? 'ds-badge-success' : 'ds-badge-neutral'} !text-[10px]`}>{o.active ? 'Active' : 'Inactive'}</span>
                      {o.showOnDashboard && <span className="ds-badge ds-badge-teal !text-[10px]">On dashboard</span>}
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border border-genz-border bg-genz-bg text-genz-muted">
                        {o.clientId ? <><User size={10} /> {o.clientLabel || 'Targeted'}</> : <><Users size={10} /> Everyone</>}
                      </span>
                    </div>
                    {o.description && <p className="text-xs text-genz-muted mt-1 line-clamp-2 break-words">{o.description}</p>}
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      {o.priceText && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-genz-teal/10 text-genz-teal border border-genz-teal/30"><Tag size={11} /> {o.priceText}</span>}
                      {(o.toolNames || []).slice(0, 5).map((t, i) => (
                        <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-100"><Package size={10} /> {t}</span>
                      ))}
                      {(o.toolNames || []).length > 5 && <span className="text-[11px] text-genz-muted">+{o.toolNames.length - 5}</span>}
                      {o.expiryDate && <span className="text-[11px] text-genz-muted">· until {fmtDate(o.expiryDate)}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button onClick={() => setSendOffer(o)} title="Send to a client"
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-bold text-white btn-grad"><Send size={14} /> Send</button>
                    <button onClick={() => toggle(o, 'showOnDashboard')} title={o.showOnDashboard ? 'Hide from dashboards' : 'Show on dashboards'}
                      className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-genz-border bg-genz-bg text-genz-teal hover:bg-genz-teal/10">{o.showOnDashboard ? <Eye size={15} /> : <EyeOff size={15} />}</button>
                    <button onClick={() => toggle(o, 'active')} title={o.active ? 'Deactivate' : 'Activate'}
                      className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-genz-border bg-genz-bg text-genz-navy hover:border-genz-teal/50 text-xs font-bold">{o.active ? 'On' : 'Off'}</button>
                    <button onClick={() => setEditing(o)} title="Edit"
                      className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-genz-border bg-genz-bg text-genz-navy hover:border-genz-teal/50"><Save size={15} /></button>
                    <button onClick={() => remove(o)} title="Delete"
                      className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-genz-border bg-genz-bg text-red-500 hover:bg-red-500/10"><Trash2 size={15} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <OfferModal offer={editing} tools={tools} crmClients={crmClients} crmLoading={crmLoading} crmSearching={crmSearching}
          onSearchClients={searchCrmClients} onClose={() => setEditing(null)} onSave={saveOffer} />
      )}
      {sendOffer && (
        <SendOfferModal offer={sendOffer} crmClients={crmClients} crmLoading={crmLoading} crmSearching={crmSearching}
          onSearchClients={searchCrmClients} emailEnabled={emailEnabled}
          onClose={() => setSendOffer(null)} showSuccess={showSuccess} showError={showError} showWarning={showWarning} />
      )}
    </AdminLayoutEnhanced>
  );
};

/* ── Modal shell ─────────────────────────────────────────────────────────────── */
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
const field = 'w-full px-3 py-2 text-sm bg-genz-bg border border-genz-border rounded-lg text-genz-navy focus:outline-none focus:border-genz-teal';
const labelCls = 'block text-xs font-medium text-genz-navy mb-1';

const OfferModal = ({ offer, tools, crmClients, crmLoading, crmSearching, onSearchClients, onClose, onSave }) => {
  const isEdit = !!offer._id;
  const [f, setF] = useState({
    _id: offer._id, title: offer.title || '', description: offer.description || '',
    kind: offer.kind || 'combo', priceText: offer.priceText || '', expiryDate: toDateInput(offer.expiryDate),
    active: offer.active !== false, showOnDashboard: !!offer.showOnDashboard,
    toolIds: Array.isArray(offer.toolIds) ? offer.toolIds.map(String) : [],
    target: offer.clientId ? 'one' : 'all', clientId: offer.clientId || '',
  });
  const activeTools = (tools || []).filter(t => t.status !== 'inactive');
  const toggleTool = (id) => setF(s => ({ ...s, toolIds: s.toolIds.includes(id) ? s.toolIds.filter(x => x !== id) : [...s.toolIds, id] }));
  const submit = () => {
    if (!f.title.trim()) return;
    onSave({
      _id: f._id, title: f.title.trim(), description: f.description, kind: f.kind, priceText: f.priceText,
      expiryDate: f.expiryDate || null, active: f.active, showOnDashboard: f.showOnDashboard,
      toolIds: f.toolIds, clientId: f.target === 'one' ? (f.clientId || null) : null,
    });
  };
  return (
    <Shell title={isEdit ? 'Edit offer' : 'New offer'} onClose={onClose}>
      <div className="space-y-3">
        <div><label className={labelCls}>Title</label><input className={field} value={f.title} maxLength={160} onChange={e => setF({ ...f, title: e.target.value })} placeholder="e.g. AI Writing Combo" /></div>
        <div><label className={labelCls}>Description (optional)</label><textarea rows={2} className={`${field} resize-none`} value={f.description} maxLength={1000} onChange={e => setF({ ...f, description: e.target.value })} placeholder="Short pitch for this offer…" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={labelCls}>Type</label><select className={field} value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>{KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}</select></div>
          <div><label className={labelCls}>Price / discount text</label><input className={field} value={f.priceText} maxLength={80} onChange={e => setF({ ...f, priceText: e.target.value })} placeholder="e.g. Save 30% · PKR 1500/mo" /></div>
        </div>
        <div>
          <label className={labelCls}>Included tools (optional)</label>
          <div className="max-h-36 overflow-y-auto border border-genz-border rounded-lg p-2 flex flex-wrap gap-1.5 bg-genz-bg/50">
            {activeTools.length === 0 ? <span className="text-xs text-genz-muted px-1">No tools available.</span> : activeTools.map(t => {
              const id = String(t._id);
              const on = f.toolIds.includes(id);
              return (
                <button key={id} type="button" onClick={() => toggleTool(id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${on ? 'bg-genz-teal/10 text-genz-teal border-genz-teal/30' : 'bg-white text-genz-muted border-genz-border hover:text-genz-navy'}`}>
                  {t.name}
                </button>
              );
            })}
          </div>
        </div>
        <div><label className={labelCls}>Expiry (optional)</label><input type="date" className={field} value={f.expiryDate} onChange={e => setF({ ...f, expiryDate: e.target.value })} /></div>
        <div>
          <label className={labelCls}>Audience</label>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <button type="button" onClick={() => setF({ ...f, target: 'all', clientId: '' })} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${f.target === 'all' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-genz-muted border-genz-border'}`}><Users size={12} className="inline mr-1" /> All clients</button>
            <button type="button" onClick={() => setF({ ...f, target: 'one' })} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${f.target === 'one' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-genz-muted border-genz-border'}`}><User size={12} className="inline mr-1" /> Specific client</button>
          </div>
          {f.target === 'one' && (
            <ClientSearchSelect id="offer-client" clients={crmClients} value={f.clientId} onChange={(id) => setF({ ...f, clientId: id })}
              loading={crmLoading} onSearch={onSearchClients} searching={crmSearching} placeholder="Search client by name or email…"
              className="bg-genz-bg border-genz-border text-genz-navy focus:border-genz-teal" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-genz-navy cursor-pointer"><input type="checkbox" className="w-4 h-4 accent-genz-teal" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> Active</label>
          <label className="flex items-center gap-2 text-sm text-genz-navy cursor-pointer"><input type="checkbox" className="w-4 h-4 accent-genz-teal" checked={f.showOnDashboard} onChange={e => setF({ ...f, showOnDashboard: e.target.checked })} /> Show on client dashboard</label>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} className="px-4 py-2 text-sm text-genz-muted hover:text-genz-navy">Cancel</button>
        <button onClick={submit} disabled={!f.title.trim()} className="btn-grad inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50"><Save size={15} /> Save offer</button>
      </div>
    </Shell>
  );
};

const SendOfferModal = ({ offer, crmClients, crmLoading, crmSearching, onSearchClients, emailEnabled, onClose, showSuccess, showError, showWarning }) => {
  const [clientId, setClientId] = useState(offer.clientId || '');
  const [waOpen, setWaOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const selected = (crmClients || []).find(c => String(c._id) === String(clientId)) || null;

  const sendEmail = async () => {
    if (!clientId) return showError('Pick a client first');
    setBusy(true);
    try {
      const res = await api.post(`/admin/offers/${offer._id}/email`, { clientId });
      if (res.data?.success) showSuccess('Offer emailed');
      else if (res.data?.emailEnabled === false) showWarning('Email is not configured on the server. Use WhatsApp instead.');
      else showError(res.data?.error || 'Could not send the email.');
    } catch (e) { showError(e.response?.data?.error || 'Could not send the email.'); }
    finally { setBusy(false); }
  };

  return (
    <Shell title={`Send offer — ${offer.title}`} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Client</label>
          <ClientSearchSelect id="send-offer-client" clients={crmClients} value={clientId} onChange={setClientId}
            loading={crmLoading} onSearch={onSearchClients} searching={crmSearching} placeholder="Search client by name or email…"
            className="bg-genz-bg border-genz-border text-genz-navy focus:border-genz-teal" />
          {selected && <p className="text-[11px] text-genz-muted mt-1">{selected.fullName} · {selected.email}{selected.phone ? ` · +${selected.phone}` : ' · no number on file'}</p>}
        </div>
        <p className="text-[11px] text-genz-muted">Opens WhatsApp with a pre-filled message you review before sending, or emails the client. Nothing is sent automatically.</p>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => { if (!clientId) return showError('Pick a client first'); setWaOpen(true); }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold border border-green-200 bg-green-50 text-green-700 hover:bg-green-100"><MessageCircle size={14} /> WhatsApp</button>
          <button onClick={sendEmail} disabled={!emailEnabled || busy || !clientId}
            title={!emailEnabled ? 'Email not configured' : 'Email this offer'}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-bold text-white btn-grad disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} Email</button>
        </div>
      </div>

      <WhatsAppSendDialog
        open={waOpen}
        client={selected || {}}
        message={buildOfferMessage({ clientName: selected?.fullName, offer })}
        onClose={() => setWaOpen(false)}
        onConfirm={() => { showSuccess('WhatsApp opened'); }}
      />
    </Shell>
  );
};

export default AdminMarketing;
