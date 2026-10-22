import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Edit3, Plus, RefreshCw, Save } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { useDebouncedValue, useResource } from '../hooks';
import { formatMoney } from '../constants';
import { Button, Card, ErrorState, Field, Input, Loading, Modal, PageHeader, SearchBox, Select, Status, Table, Textarea } from '../components/ui';

const empty = (currency) => ({ name: '', category: 'Software', accountType: 'private', durationLabel: '1 Month', defaultSalePrice: '0.00', defaultPurchaseCost: '0.00', currencyCode: currency, active: true, notes: '', version: 1 });

/**
 * One label per product, from the source status the API returns.
 *
 * `row.source` is absent for a manual product, which is how the two are told apart - never by
 * guessing from the name. The order matters: an ignored or unavailable source is reported as such
 * even while its commercial setup is still incomplete, because those are independent facts.
 */
function sourceLabel(row) {
  if (!row.source) return { text: 'Manual', tone: 'neutral' };
  if (row.source.ignored) return { text: 'Ignored', tone: 'neutral' };
  if (row.source.availability !== 'AVAILABLE') return { text: 'Source unavailable', tone: 'warning' };
  if (row.source.readiness !== 'READY') return { text: 'Needs setup', tone: 'warning' };
  return { text: 'Website-linked', tone: 'success' };
}

/**
 * A NEEDS_SETUP product has no confirmed commercial data. The API already nulls those fields so
 * nothing can read the stored placeholders as real, and this renders the absence as an em dash
 * rather than a misleading 0.00.
 */
const confirmed = (row) => !row.source || row.commercialDetailsConfirmed !== false;

export default function Products() {
  const crm = useBusinessCrm();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const canManage = crm.has('products.manage');
  const canSeeCost = crm.has('profit.view') || canManage;
  const debounced = useDebouncedValue(query);
  const resource = useResource(() => `/products?pageSize=100&currency=${crm.currency}&q=${encodeURIComponent(debounced)}`, [crm.currency, debounced]);
  const [catalogue, setCatalogue] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const autoTried = useRef(false);

  /**
   * BOUNDED automatic discovery, and only for a manager.
   *
   * A products.view-only viewer never triggers a write - the status read below is a GET and the
   * reconcile is skipped entirely for them. `autoTried` makes this at most once per mount, and the
   * server refuses anyway unless its own cross-worker freshness window has elapsed, so repeated
   * page opens and several managers at once cannot turn into repeated full imports.
   *
   * DISCOVERY IS NOT CONTINUOUS: a new website Tool appears here at the next eligible
   * reconciliation. Nothing runs while the CRM is closed.
   */
  const refreshStatus = useCallback(async () => {
    try { setCatalogue((await crmApi.get('/products/catalogue/status')).data); } catch (_) { /* status is informational */ }
  }, []);

  // `resource` is a fresh object each render, so depending on it here would give runSync a new
  // identity every render and re-fire the effect below. The reload is reached through a ref so the
  // callback stays stable and the auto-sync genuinely runs at most once per mount.
  const reloadRef = useRef(resource.reload);
  reloadRef.current = resource.reload;
  const runSync = useCallback(async (force) => {
    setSyncing(true);
    try {
      await crmApi.post('/products/catalogue/reconcile', force ? { force: true } : {});
      await refreshStatus();
      reloadRef.current();
    } catch (requestError) { setError(messageFromError(requestError)); }
    finally { setSyncing(false); }
  }, [refreshStatus]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    if (!canManage || autoTried.current || !catalogue) return;
    autoTried.current = true;
    if (!catalogue.fresh) runSync(false);
  }, [canManage, catalogue, runSync]);

  const edit = (product) => setForm({
    id: product.id, name: product.name, category: product.category, accountType: product.account_type,
    durationLabel: product.duration_label || '', defaultSalePrice: product.default_sale_price,
    defaultPurchaseCost: product.default_purchase_cost ?? '0.00', currencyCode: product.currency_code,
    active: Boolean(product.active), notes: product.notes || '', version: product.version,
  });
  /**
   * Explicit commercial confirmation. Deliberately separate from Save: correcting a name must never
   * make an imported product sellable, because the placeholder price and account type would come
   * with it. A zero price is only accepted when the operator states that it is intentional.
   */
  const confirmReady = async (row) => {
    const free = Number(row.default_sale_price || 0) === 0;
    if (free && !window.confirm(`"${row.name}" has no sale price. Confirm it is intentionally FREE?`)) return;
    try {
      await crmApi.post(`/products/${row.id}/catalogue/confirm-ready`, { confirmFree: free });
      setError(''); await refreshStatus(); resource.reload();
    } catch (requestError) { setError(messageFromError(requestError)); }
  };

  const save = async () => {
    try {
      if (form.id) await crmApi.put(`/products/${form.id}`, form);
      else await crmApi.post('/products', form);
      setForm(null); setError(''); resource.reload();
    } catch (requestError) { setError(messageFromError(requestError)); }
  };

  if (resource.initialLoading) return <Loading />;
  if (resource.error) return <ErrorState message={resource.error} onRetry={resource.reload} />;

  const columns = [
    { key: 'name', label: 'Product' }, { key: 'category', label: 'Category' },
    { key: 'account_type', label: 'Type' }, { key: 'duration_label', label: 'Duration' },
    { key: 'default_sale_price', label: 'Sale', render: (row) => (confirmed(row) ? formatMoney(row.default_sale_price, row.currency_code) : <span className="bcrm-muted">—</span>) },
    ...(canSeeCost ? [{ key: 'default_purchase_cost', label: 'Cost', render: (row) => (confirmed(row) ? formatMoney(row.default_purchase_cost, row.currency_code) : <span className="bcrm-muted">—</span>) }] : []),
    { key: 'source', label: 'Source', render: (row) => { const label = sourceLabel(row); return <Status tone={label.tone}>{label.text}</Status>; } },
    { key: 'active', label: 'Status', render: (row) => <Status tone={row.active ? 'success' : 'neutral'}>{row.active ? 'active' : 'inactive'}</Status> },
    { key: 'actions', label: '', render: (row) => canManage ? <div className="bcrm-row-actions">
      <button className="bcrm-btn bcrm-btn-secondary" onClick={() => edit(row)}><Edit3 size={14} /> Edit</button>
      {row.source && row.commercialDetailsConfirmed === false
        ? <button className="bcrm-btn bcrm-btn-secondary" onClick={() => confirmReady(row)}><CheckCircle2 size={14} /> Confirm details</button>
        : null}
    </div> : null },
  ];

  return <>
    <PageHeader title="Product catalogue" description="Reusable pricing, account type and duration presets for faster invoice entry." actions={canManage && <>
      <Button variant="secondary" icon={RefreshCw} disabled={syncing} onClick={() => runSync(true)}>{syncing ? 'Checking…' : 'Check website tools'}</Button>
      <Button icon={Plus} onClick={() => setForm(empty(crm.currency))}>New product</Button>
    </>} />
    {catalogue && <div className="bcrm-banner info">
      {catalogue.lastRunAt
        ? `Website tools last checked ${new Date(catalogue.lastRunAt).toLocaleString()}.`
        : 'Website tools have not been checked yet.'}
      {' '}{catalogue.discoveryNote}
    </div>}
    <div className="bcrm-filterbar"><SearchBox value={query} onChange={setQuery} busy={resource.loading} placeholder="Product, category or duration…" /></div>
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
