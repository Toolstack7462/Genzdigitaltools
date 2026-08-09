import { useState } from 'react';
import { Edit3, Plus, Save } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { useResource } from '../hooks';
import { formatMoney } from '../constants';
import { Button, Card, ErrorState, Field, Input, Loading, Modal, PageHeader, SearchBox, Select, Status, Table, Textarea } from '../components/ui';

const empty = (currency) => ({ name: '', category: 'Software', accountType: 'private', durationLabel: '1 Month', defaultSalePrice: '0.00', defaultPurchaseCost: '0.00', currencyCode: currency, active: true, notes: '', version: 1 });

export default function Products() {
  const crm = useBusinessCrm();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const canManage = crm.has('products.manage');
  const canSeeCost = crm.has('profit.view') || canManage;
  const resource = useResource(() => `/products?pageSize=500&currency=${crm.currency}&q=${encodeURIComponent(query)}`, [crm.currency, query]);

  const edit = (product) => setForm({
    id: product.id, name: product.name, category: product.category, accountType: product.account_type,
    durationLabel: product.duration_label || '', defaultSalePrice: product.default_sale_price,
    defaultPurchaseCost: product.default_purchase_cost ?? '0.00', currencyCode: product.currency_code,
    active: Boolean(product.active), notes: product.notes || '', version: product.version,
  });
  const save = async () => {
    try {
      if (form.id) await crmApi.put(`/products/${form.id}`, form);
      else await crmApi.post('/products', form);
      setForm(null); setError(''); resource.reload();
    } catch (requestError) { setError(messageFromError(requestError)); }
  };

  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorState message={resource.error} onRetry={resource.reload} />;

  const columns = [
    { key: 'name', label: 'Product' }, { key: 'category', label: 'Category' },
    { key: 'account_type', label: 'Type' }, { key: 'duration_label', label: 'Duration' },
    { key: 'default_sale_price', label: 'Sale', render: (row) => formatMoney(row.default_sale_price, row.currency_code) },
    ...(canSeeCost ? [{ key: 'default_purchase_cost', label: 'Cost', render: (row) => formatMoney(row.default_purchase_cost, row.currency_code) }] : []),
    { key: 'active', label: 'Status', render: (row) => <Status tone={row.active ? 'success' : 'neutral'}>{row.active ? 'active' : 'inactive'}</Status> },
    { key: 'actions', label: '', render: (row) => canManage ? <button className="bcrm-btn bcrm-btn-secondary" onClick={() => edit(row)}><Edit3 size={14} /> Edit</button> : null },
  ];

  return <>
    <PageHeader title="Product catalogue" description="Reusable pricing, account type and duration presets for faster invoice entry." actions={canManage && <Button icon={Plus} onClick={() => setForm(empty(crm.currency))}>New product</Button>} />
    <div className="bcrm-filterbar"><SearchBox value={query} onChange={setQuery} placeholder="Product or category…" /></div>
    <Card className="flush"><Table rows={resource.data?.rows || []} columns={columns} /></Card>
    <Modal open={Boolean(form)} title={form?.id ? 'Edit product' : 'New product'} onClose={() => setForm(null)} footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button icon={Save} onClick={save}>Save</Button></>}>
      {error && <div className="bcrm-banner warning">{error}</div>}
      {form && <div className="bcrm-form-grid">
        <Field label="Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
        <Field label="Category"><Input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></Field>
        <Field label="Account type"><Select value={form.accountType} onChange={(event) => setForm({ ...form, accountType: event.target.value })}><option value="private">Private</option><option value="shared">Shared</option><option value="service">Service</option><option value="other">Other</option></Select></Field>
        <Field label="Duration"><Input value={form.durationLabel} onChange={(event) => setForm({ ...form, durationLabel: event.target.value })} /></Field>
        <Field label="Sale price"><Input inputMode="decimal" value={form.defaultSalePrice} onChange={(event) => setForm({ ...form, defaultSalePrice: event.target.value })} /></Field>
        <Field label="Purchase cost"><Input inputMode="decimal" value={form.defaultPurchaseCost} onChange={(event) => setForm({ ...form, defaultPurchaseCost: event.target.value })} /></Field>
        <Field label="Currency"><Select value={form.currencyCode} onChange={(event) => setForm({ ...form, currencyCode: event.target.value })}>{['PKR', 'INR', 'NGN'].map((code) => <option key={code}>{code}</option>)}</Select></Field>
        <label className="bcrm-check"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /> Active catalogue item</label>
        <Field label="Notes"><Textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></Field>
      </div>}
    </Modal>
  </>;
}
