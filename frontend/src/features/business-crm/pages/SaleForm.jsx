import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { formatMoney, today } from '../constants';
import { offlineDb } from '../offline/db';
import { queueOperation } from '../offline/queue';
import { Button, Card, ErrorState, Field, Input, Loading, PageHeader, Select, Textarea } from '../components/ui';

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

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const saleResponse = editing ? await crmApi.get(`/sales/${id}${credentialsView ? '?credentials=1' : ''}`) : null;
        const targetCurrency = saleResponse?.data?.currency_code || crm.currency;
        const [clientResponse, vendorResponse, productResponse] = await Promise.all([
          crmApi.get('/contacts/clients?pageSize=500'),
          vendorVisible ? crmApi.get('/contacts/vendors?pageSize=500') : Promise.resolve({ data: { rows: [] } }),
          crmApi.get(`/products?pageSize=500&currency=${targetCurrency}`),
        ]);
        if (!active) return;
        const clientRows = clientResponse.data.rows || [];
        const vendorRows = vendorResponse.data.rows || [];
        const productRows = productResponse.data.rows || [];
        setClients(clientRows); setVendors(vendorRows); setProducts(productRows);
        await Promise.all([
          offlineDb.putCache('clients', clientRows),
          vendorVisible ? offlineDb.putCache('vendors', vendorRows) : Promise.resolve(),
          offlineDb.putCache(`products:${targetCurrency}`, productRows),
        ]);
        if (saleResponse) {
          const sale = saleResponse.data;
          setCurrencyLocked(Number(sale.client_paid || 0) > 0 || Number(sale.vendor_paid || 0) > 0);
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
      } catch (requestError) {
        if (!navigator.onLine && !editing) {
          const [clientCache, vendorCache, productCache] = await Promise.all([
            offlineDb.getCache('clients'), vendorVisible ? offlineDb.getCache('vendors') : Promise.resolve(null), offlineDb.getCache(`products:${crm.currency}`),
          ]);
          if (!active) return;
          setClients(clientCache?.value || []); setVendors(vendorCache?.value || []); setProducts(productCache?.value || []);
          setForm(initialForm(crm.currency));
          if (!clientCache?.value?.length || !productCache?.value?.length) setError('Connect once before creating an offline sale so clients and products can be cached.');
        } else if (active) setError(messageFromError(requestError));
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [id, editing, crm.currency, vendorVisible, credentialsView]);

  const totals = useMemo(() => form.items.reduce((sum, item) => ({ sale: sum.sale + Number(item.salePrice || 0), cost: sum.cost + Number(item.purchaseCost || 0) }), { sale: 0, cost: 0 }), [form.items]);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const updateItem = (index, key, value) => setForm((current) => ({ ...current, items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item) }));
  const changeCurrency = async (currencyCode) => {
    if (currencyLocked) return;
    setForm((current) => ({ ...current, currencyCode, items: current.items.map(() => blankItem()) }));
    try {
      const response = await crmApi.get(`/products?pageSize=500&currency=${currencyCode}`);
      setProducts(response.data.rows || []); await offlineDb.putCache(`products:${currencyCode}`, response.data.rows || []);
    } catch (requestError) {
      const cache = await offlineDb.getCache(`products:${currencyCode}`);
      setProducts(cache?.value || []);
      if (!cache?.value?.length) setError(messageFromError(requestError));
    }
  };
  const pickProduct = (index, productId) => {
    const product = products.find((entry) => entry.id === productId);
    if (!product) {
      updateItem(index, 'productId', '');
      if (!costVisible) updateItem(index, 'name', '');
      return;
    }
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
        await queueOperation('sale.create', clean, crm.bootstrap?.user?.id); crm.setQueued(crm.queued + 1); navigate('../sales'); return;
      }
      const response = editing ? await crmApi.put(`/sales/${id}`, payload) : await crmApi.post('/sales', payload);
      navigate(`/admin/business/sales/${response.data.id}`);
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
        <Field label="Client"><Select required value={form.clientId} onChange={(event) => update('clientId', event.target.value)}><option value="">Select client</option>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</Select></Field>
        {vendorVisible && <Field label="Vendor"><Select value={form.vendorId} onChange={(event) => update('vendorId', event.target.value)}><option value="">No vendor</option>{vendors.map((vendor) => <option value={vendor.id} key={vendor.id}>{vendor.name}</option>)}</Select></Field>}
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
          <Field label="Catalogue product"><Select required={!costVisible} value={item.productId} onChange={(event) => pickProduct(index, event.target.value)}><option value="">{costVisible ? 'Custom item' : 'Select product'}</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</Select></Field>
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
  </form>;
}
