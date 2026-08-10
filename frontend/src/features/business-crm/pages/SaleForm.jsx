import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Save, Trash2, UserPlus } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { crmPath, formatMoney, today } from '../constants';
import { offlineDb } from '../offline/db';
import { queueOperation } from '../offline/queue';
import { Button, Card, Combobox, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Textarea } from '../components/ui';

// One page of suggestions per keystroke-settled search. The previous form loaded 500 clients, 500
// vendors and 500 products before it would render at all, then put every one of them into a <select>.
const SUGGEST_PAGE = 25;
const blankQuickClient = () => ({ name: '', whatsapp: '', email: '' });

const blankItem = () => ({
  id: '', productId: '', name: '', accountType: 'private', durationLabel: '1 Month',
  purchaseDate: today(), expiryDate: '', credentialEmail: '', credentialPassword: '',
  keepCredentialEmail: false, keepCredentialPassword: false, salePrice: '0.00', purchaseCost: '0.00',
});
const initialForm = (currency) => ({
  clientId: '', vendorId: '', saleDate: today(), orderType: 'new', currencyCode: currency,
  notes: '', invoiceInstructions: '', openingClientPayment: '0.00', openingVendorPayment: '0.00',
  paymentMethod: 'Cash', version: 1, items: [blankItem()],
});

export default function SaleForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const crm = useBusinessCrm();
  const navigate = useNavigate();
  const costVisible = crm.has('profit.view');
  const vendorVisible = crm.has('vendors.view');
  const clientPaymentAllowed = crm.has('payments.client.record');
  const vendorPaymentAllowed = crm.has('payments.vendor.record');
  const credentialsManage = crm.has('credentials.manage');
  const credentialsView = crm.has('credentials.view');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [clients, setClients] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [products, setProducts] = useState([]);
  const [currencyLocked, setCurrencyLocked] = useState(false);
  const [form, setForm] = useState(() => initialForm(crm.currency));
  // The combobox shows a label for the current selection. Kept OUTSIDE `form` on purpose: the submit
  // payload spreads `form` wholesale, and the sale schema would reject unknown keys.
  const [clientLabel, setClientLabel] = useState('');
  const [vendorLabel, setVendorLabel] = useState('');
  const [quickClient, setQuickClient] = useState(null);
  const [quickSaving, setQuickSaving] = useState(false);
  const [quickError, setQuickError] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const saleResponse = editing ? await crmApi.get(`/sales/${id}${credentialsView ? '?credentials=1' : ''}`) : null;
        if (!active) return;
        if (saleResponse) {
          const sale = saleResponse.data;
          setCurrencyLocked(Number(sale.client_paid || 0) > 0 || Number(sale.vendor_paid || 0) > 0);
          setClientLabel(sale.client_name || '');
          setVendorLabel(sale.vendor_name || '');
          setForm({
            clientId: sale.client_id, vendorId: sale.vendor_id || '', saleDate: sale.sale_date,
            orderType: sale.order_type, currencyCode: sale.currency_code, notes: sale.notes || '',
            invoiceInstructions: sale.invoice_instructions || '', openingClientPayment: '0.00', openingVendorPayment: '0.00',
            paymentMethod: 'Cash', version: sale.version,
            items: (sale.items || []).map((item) => ({
              id: item.id, productId: item.product_id || '', name: item.name, accountType: item.account_type,
              durationLabel: item.duration_label || '', purchaseDate: item.purchase_date || '', expiryDate: item.expiry_date || '',
              credentialEmail: item.credential_email || '', credentialPassword: item.credential_password || '',
              keepCredentialEmail: Boolean(item.has_credential_email), keepCredentialPassword: Boolean(item.has_credential_password),
              salePrice: item.sale_price, purchaseCost: item.purchase_cost ?? '0.00',
            })),
          });
        } else setForm(initialForm(crm.currency));
        if (!navigator.onLine) await loadOfflineLists(saleResponse?.data?.currency_code || crm.currency, active);
      } catch (requestError) {
        if (!navigator.onLine && !editing) {
          await loadOfflineLists(crm.currency, active);
          if (active) setForm(initialForm(crm.currency));
        } else if (active) setError(messageFromError(requestError));
      } finally { if (active) setLoading(false); }
    })();

    async function loadOfflineLists(currency, stillActive) {
      const [clientCache, vendorCache, productCache] = await Promise.all([
        offlineDb.getCache('clients'),
        vendorVisible ? offlineDb.getCache('vendors') : Promise.resolve(null),
        offlineDb.getCache(`products:${currency}`),
      ]);
      if (!stillActive || !active) return;
      setClients(clientCache?.value || []); setVendors(vendorCache?.value || []); setProducts(productCache?.value || []);
      if (!clientCache?.value?.length || !productCache?.value?.length) setError('Connect once before creating an offline sale so clients and products can be cached.');
    }
    return () => { active = false; };
  }, [id, editing, crm.currency, vendorVisible, credentialsView]);

  // Offline cache warming is deliberately OUTSIDE the load path above, so the form renders as soon as
  // the sale itself has arrived. The bulk lists exist only to make an offline sale possible; making
  // the operator wait for them before the first field is usable was the reason this page felt slow.
  const warmCurrency = form.currencyCode;
  useEffect(() => {
    if (!navigator.onLine) return undefined;
    let active = true;
    const warm = async (key, url, apply) => {
      try {
        const response = await crmApi.get(url);
        if (!active) return;
        const rows = response.data.rows || [];
        apply(rows);
        await offlineDb.putCache(key, rows);
      } catch { /* Cache warming is best effort: a failure here must not surface as a form error. */ }
    };
    warm('clients', '/contacts/clients?pageSize=500', setClients);
    if (vendorVisible) warm('vendors', '/contacts/vendors?pageSize=500', setVendors);
    warm(`products:${warmCurrency}`, `/products?pageSize=500&currency=${warmCurrency}`, setProducts);
    return () => { active = false; };
  }, [warmCurrency, vendorVisible]);

  // Suggestion sources. Online they hit the module's own list endpoints with the same `q` filter the
  // list pages use; offline they fall back to the warmed cache so an offline sale is still possible.
  const suggest = useCallback(async (url, rows, matches, toOption) => {
    if (navigator.onLine) {
      const response = await crmApi.get(url);
      return (response.data.rows || []).map(toOption);
    }
    return rows.filter(matches).slice(0, SUGGEST_PAGE).map(toOption);
  }, []);
  const searchClients = useCallback(async (text) => suggest(
    `/contacts/clients?pageSize=${SUGGEST_PAGE}&q=${encodeURIComponent(text)}`,
    clients,
    (row) => [row.name, row.whatsapp, row.email, row.company].some((field) => String(field || '').toLowerCase().includes(text.toLowerCase())),
    (row) => ({ id: row.id, label: row.name, hint: [row.company, row.whatsapp, row.email].filter(Boolean).join(' • ') || undefined, raw: row }),
  ), [suggest, clients]);
  const searchVendors = useCallback(async (text) => suggest(
    `/contacts/vendors?pageSize=${SUGGEST_PAGE}&q=${encodeURIComponent(text)}`,
    vendors,
    (row) => [row.name, row.whatsapp, row.email, row.company].some((field) => String(field || '').toLowerCase().includes(text.toLowerCase())),
    (row) => ({ id: row.id, label: row.name, hint: [row.company, row.whatsapp].filter(Boolean).join(' • ') || undefined, raw: row }),
  ), [suggest, vendors]);
  const searchProducts = useCallback(async (text) => suggest(
    `/products?pageSize=${SUGGEST_PAGE}&currency=${form.currencyCode}&q=${encodeURIComponent(text)}`,
    products,
    (row) => [row.name, row.category].some((field) => String(field || '').toLowerCase().includes(text.toLowerCase())),
    (row) => ({ id: row.id, label: row.name, hint: [row.category, row.duration_label, formatMoney(row.default_sale_price, row.currency_code)].filter(Boolean).join(' • '), raw: row }),
  ), [suggest, products, form.currencyCode]);

  const createQuickClient = async () => {
    setQuickSaving(true); setQuickError('');
    try {
      const payload = { name: quickClient.name.trim(), whatsapp: quickClient.whatsapp.trim() || '', email: quickClient.email.trim() || '', company: '', address: '', taxId: '', notes: '', status: 'active' };
      if (!payload.name) throw new Error('Client name is required.');
      const response = await crmApi.post('/contacts/clients', payload);
      const created = response.data?.id ? response.data : response.data?.client;
      // Selecting the new client only touches these two pieces of state, so everything already typed
      // into the sale — items, prices, credentials, notes — is still there when the modal closes.
      update('clientId', created.id);
      setClientLabel(created.name);
      setClients((current) => [created, ...current]);
      setQuickClient(null);
    } catch (requestError) { setQuickError(messageFromError(requestError)); }
    finally { setQuickSaving(false); }
  };

  const totals = useMemo(() => form.items.reduce((sum, item) => ({ sale: sum.sale + Number(item.salePrice || 0), cost: sum.cost + Number(item.purchaseCost || 0) }), { sale: 0, cost: 0 }), [form.items]);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const updateItem = (index, key, value) => setForm((current) => ({ ...current, items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item) }));
  const changeCurrency = (currencyCode) => {
    if (currencyLocked) return;
    // Items are cleared because catalogue prices are per-currency. The product cache for the new
    // currency is warmed by the effect above, which keys on form.currencyCode.
    setForm((current) => ({ ...current, currencyCode, items: current.items.map(() => blankItem()) }));
  };
  const clearProduct = (index) => setForm((current) => ({
    ...current,
    items: current.items.map((item, itemIndex) => itemIndex === index
      ? { ...item, productId: '', ...(costVisible ? {} : { name: '' }) }
      : item),
  }));
  // Auto-fill is unchanged in behaviour; it now receives the product record straight from the chosen
  // suggestion instead of looking it up in a 500-row array that had to be loaded up front.
  const pickProduct = (index, product) => {
    if (!product) { clearProduct(index); return; }
    setForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? {
        ...item, productId: product.id, name: product.name, accountType: product.account_type,
        durationLabel: product.duration_label || '', salePrice: product.default_sale_price,
        purchaseCost: product.default_purchase_cost ?? item.purchaseCost ?? '0.00',
      } : item),
    }));
  };

  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const items = form.items.map((item) => {
        const output = {
          ...item, id: item.id || null, productId: item.productId || null,
          purchaseDate: item.purchaseDate || null, expiryDate: item.expiryDate || null,
        };
        if (!costVisible) delete output.purchaseCost;
        if (!credentialsManage) {
          delete output.credentialEmail; delete output.credentialPassword;
          delete output.keepCredentialEmail; delete output.keepCredentialPassword;
        }
        return output;
      });
      if (!costVisible && items.some((item) => !item.productId)) throw new Error('Select a catalogue product for every item. Custom costing requires Manager access.');
      const payload = {
        ...form, items,
        vendorId: vendorVisible ? (form.vendorId || null) : null,
        openingClientPayment: clientPaymentAllowed ? form.openingClientPayment : '0.00',
        openingVendorPayment: vendorPaymentAllowed ? form.openingVendorPayment : '0.00',
      };
      if (!navigator.onLine) {
        if (editing) throw new Error('Existing financial records can only be edited online.');
        if (!crm.has('offline.sync')) throw new Error('Your role cannot queue offline financial entries.');
        if (payload.items.some((item) => item.credentialEmail || item.credentialPassword)) throw new Error('Credentials cannot be stored in the offline queue. Remove them or reconnect.');
        const clean = { ...payload, items: payload.items.map(({ credentialEmail, credentialPassword, keepCredentialEmail, keepCredentialPassword, ...rest }) => rest) };
        await queueOperation('sale.create', clean, crm.bootstrap?.user?.id); crm.setQueued(crm.queued + 1); navigate(crmPath('sales')); return;
      }
      const response = editing ? await crmApi.put(`/sales/${id}`, payload) : await crmApi.post('/sales', payload);
      navigate(crmPath(`sales/${response.data.id}`));
    } catch (requestError) { setError(messageFromError(requestError)); }
    finally { setSaving(false); }
  };

  if (loading) return <Loading />;
  if (error && editing && !form.clientId) return <ErrorState message={error} />;

  return <form onSubmit={submit}>
    <PageHeader title={editing ? 'Edit sale' : 'Create sale'} description="Invoice, access delivery and approved ledgers are recorded in one controlled transaction." actions={<><Button type="button" variant="secondary" onClick={() => navigate(-1)}>Cancel</Button><Button type="submit" icon={Save} disabled={saving}>{saving ? 'Saving…' : 'Save sale'}</Button></>} />
    {error && <div className="bcrm-banner warning">{error}</div>}
    <Card title="Invoice details" subtitle="Currency becomes locked after the first posted payment">
      <div className="bcrm-form-grid bcrm-form-grid-3">
        <Field label="Client" hint="Search by name, phone, email or company">
          <Combobox
            name="clientId" required value={form.clientId} valueLabel={clientLabel} search={searchClients}
            placeholder="Search clients…" emptyHint="No client matches that search"
            onSelect={(option) => { update('clientId', option.id); setClientLabel(option.label); }}
            onClear={() => { update('clientId', ''); setClientLabel(''); }}
            footer={crm.has('clients.create') && <Button type="button" variant="ghost" icon={UserPlus} onClick={() => { setQuickError(''); setQuickClient(blankQuickClient()); }}>Create new client</Button>}
          />
        </Field>
        {vendorVisible && <Field label="Vendor" hint="Optional">
          <Combobox
            value={form.vendorId} valueLabel={vendorLabel} search={searchVendors}
            placeholder="Search vendors…" emptyHint="No vendor matches that search"
            onSelect={(option) => { update('vendorId', option.id); setVendorLabel(option.label); }}
            onClear={() => { update('vendorId', ''); setVendorLabel(''); }}
          />
        </Field>}
        <Field label="Sale date"><Input type="date" required value={form.saleDate} onChange={(event) => update('saleDate', event.target.value)} /></Field>
        <Field label="Order type"><Select value={form.orderType} onChange={(event) => update('orderType', event.target.value)}><option value="new">New</option><option value="renewal">Renewal</option></Select></Field>
        <Field label="Currency" hint={currencyLocked ? 'Locked because a payment is already posted.' : 'PKR, INR and NGN remain separate ledgers.'}><Select value={form.currencyCode} onChange={(event) => changeCurrency(event.target.value)} disabled={currencyLocked}>{['PKR', 'INR', 'NGN'].map((code) => <option key={code}>{code}</option>)}</Select></Field>
        {(clientPaymentAllowed || vendorPaymentAllowed) && <Field label="Payment method"><Select value={form.paymentMethod} onChange={(event) => update('paymentMethod', event.target.value)}><option>Cash</option><option>Bank</option><option>JazzCash</option><option>Easypaisa</option><option>UPI</option><option>Other</option></Select></Field>}
      </div>
    </Card>
    <Card title="Products & access" subtitle="Maximum 20 items. Sensitive access data is encrypted only after it reaches the server." className="bcrm-section">
      {form.items.map((item, index) => <div className="bcrm-sale-item" key={item.id || index}>
        <div className="bcrm-item-title"><strong>Item {index + 1}</strong>{form.items.length > 1 && <button type="button" onClick={() => setForm((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))} aria-label={`Remove item ${index + 1}`}><Trash2 size={15} /></button>}</div>
        <div className="bcrm-form-grid bcrm-form-grid-3">
          <Field label="Catalogue product" hint={costVisible ? 'Leave empty for a custom item' : 'Required for your role'}>
            <Combobox
              required={!costVisible} value={item.productId} valueLabel={item.productId ? item.name : ''} search={searchProducts}
              placeholder={costVisible ? 'Search catalogue, or leave empty' : 'Search catalogue…'}
              emptyHint={`No ${form.currencyCode} product matches that search`}
              onSelect={(option) => pickProduct(index, option.raw)}
              onClear={() => clearProduct(index)}
            />
          </Field>
          <Field label="Product / service"><Input required readOnly={!costVisible} value={item.name} onChange={(event) => updateItem(index, 'name', event.target.value)} /></Field>
          <Field label="Account type"><Select value={item.accountType} onChange={(event) => updateItem(index, 'accountType', event.target.value)}><option value="private">Private</option><option value="shared">Shared</option><option value="service">Service</option><option value="other">Other</option></Select></Field>
          <Field label="Duration"><Input value={item.durationLabel} onChange={(event) => updateItem(index, 'durationLabel', event.target.value)} /></Field>
          <Field label="Purchase date"><Input type="date" value={item.purchaseDate} onChange={(event) => updateItem(index, 'purchaseDate', event.target.value)} /></Field>
          <Field label="Expiry date"><Input type="date" value={item.expiryDate} onChange={(event) => updateItem(index, 'expiryDate', event.target.value)} /></Field>
          <Field label="Sale price"><Input required inputMode="decimal" value={item.salePrice} onChange={(event) => updateItem(index, 'salePrice', event.target.value)} /></Field>
          {costVisible && <Field label="Purchase cost"><Input required inputMode="decimal" value={item.purchaseCost} onChange={(event) => updateItem(index, 'purchaseCost', event.target.value)} /></Field>}
          {credentialsManage && <><Field label="Customer login"><Input autoComplete="off" value={item.credentialEmail} placeholder={item.keepCredentialEmail ? 'Stored — leave blank to keep' : ''} onChange={(event) => updateItem(index, 'credentialEmail', event.target.value)} /></Field><Field label="Customer password"><Input type="password" autoComplete="new-password" value={item.credentialPassword} placeholder={item.keepCredentialPassword ? 'Stored — leave blank to keep' : ''} onChange={(event) => updateItem(index, 'credentialPassword', event.target.value)} /></Field></>}
        </div>
      </div>)}
      {form.items.length < 20 && <div className="bcrm-form-actions"><Button type="button" variant="secondary" icon={Plus} onClick={() => setForm((current) => ({ ...current, items: [...current.items, blankItem()] }))}>Add item</Button></div>}
      <div className="bcrm-totalbar">
        <div><span>Invoice total</span><strong>{formatMoney(totals.sale, form.currencyCode)}</strong></div>
        {costVisible && <><div><span>Purchase cost</span><strong>{formatMoney(totals.cost, form.currencyCode)}</strong></div><div><span>Gross profit</span><strong>{formatMoney(totals.sale - totals.cost, form.currencyCode)}</strong></div></>}
      </div>
    </Card>
    {(clientPaymentAllowed || vendorPaymentAllowed) && <Card title="Opening payments" subtitle="Amounts cannot exceed the corresponding ledger total" className="bcrm-section"><div className="bcrm-form-grid">
      {clientPaymentAllowed && <Field label="Client received now"><Input inputMode="decimal" value={form.openingClientPayment} onChange={(event) => update('openingClientPayment', event.target.value)} /></Field>}
      {vendorPaymentAllowed && vendorVisible && <Field label="Vendor paid now"><Input inputMode="decimal" value={form.openingVendorPayment} onChange={(event) => update('openingVendorPayment', event.target.value)} /></Field>}
    </div></Card>}
    <Card title="Notes & invoice instructions" className="bcrm-section"><div className="bcrm-form-grid"><Field label="Internal notes"><Textarea value={form.notes} onChange={(event) => update('notes', event.target.value)} /></Field><Field label="Customer invoice instructions"><Textarea value={form.invoiceInstructions} onChange={(event) => update('invoiceInstructions', event.target.value)} /></Field></div></Card>
    {/*
      Quick client capture. Only Name is required; the full client record can be completed later from
      the Clients page. This creates a CRM contact and nothing else — no website assignment, no tool
      access and no portal login, which the existing website access flows continue to own.
    */}
    <Modal
      open={Boolean(quickClient)} title="Create new client" onClose={() => setQuickClient(null)}
      footer={<><Button type="button" variant="secondary" onClick={() => setQuickClient(null)}>Cancel</Button><Button type="button" icon={Save} onClick={createQuickClient} disabled={quickSaving || !quickClient?.name?.trim()}>{quickSaving ? 'Saving…' : 'Save and select'}</Button></>}
    >
      {quickClient && <>
        {quickError && <div className="bcrm-banner warning">{quickError}</div>}
        <p className="bcrm-modal-note">This adds a CRM contact only. It grants no tool access and creates no website assignment.</p>
        <div className="bcrm-form-grid">
          <Field label="Name"><Input autoFocus value={quickClient.name} onChange={(event) => setQuickClient({ ...quickClient, name: event.target.value })} /></Field>
          <Field label="WhatsApp" hint="Optional"><Input value={quickClient.whatsapp} onChange={(event) => setQuickClient({ ...quickClient, whatsapp: event.target.value })} /></Field>
          <Field label="Email" hint="Optional"><Input type="email" value={quickClient.email} onChange={(event) => setQuickClient({ ...quickClient, email: event.target.value })} /></Field>
        </div>
      </>}
    </Modal>
  </form>;
}
