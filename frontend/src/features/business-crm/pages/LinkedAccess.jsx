import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Ban, Link2, RefreshCw, Undo2 } from 'lucide-react';
import { crmApi, messageFromError } from '../api';
import { useBusinessCrm } from '../BusinessCrmContext';
import { CURRENCIES, formatDate, today } from '../constants';
import { useDebouncedValue } from '../hooks';
import { Button, Card, Empty, ErrorState, Field, Input, Loading, Modal, PageHeader, SearchBox, Select, Status, Table, Textarea } from '../components/ui';

/**
 * Website Access — the reconciliation inbox.
 *
 * Everything operational on this page (client identity, tool, start date, duration, expiry, access
 * status) is mirrored from the existing website access system and is READ-ONLY here. The only thing
 * entered on this page is money, and it is entered inside the CRM — the existing Give Access,
 * Assign Tool, Bulk Assign, Proxy and StealthWriter screens are never touched and carry no
 * financial fields.
 */

const FINANCIAL_FILTERS = [
  ['', 'All financial states'],
  ['NEEDS_FINANCIAL_DETAILS', 'Needs Financial Details'],
  ['LINKED_TO_SALE', 'Linked to Sale'],
  ['NON_BILLABLE', 'Non-Billable'],
  ['IGNORED', 'Ignored'],
];
const ACCESS_FILTERS = [
  ['', 'All access states'],
  ['ACTIVE', 'Active'],
  ['EXPIRING', 'Expiring'],
  ['EXPIRED', 'Expired'],
  ['REVOKED', 'Revoked'],
  ['SOURCE_MISSING', 'Source Missing'],
];
const SOURCE_LABELS = {
  CORE_ASSIGNMENT: 'Website assignment',
  PROXY: 'Proxy tool',
  STEALTH: 'StealthWriter',
  MANUAL: 'Manual',
};
const ACCESS_TONE = { ACTIVE: 'success', EXPIRING: 'warning', EXPIRED: 'danger', REVOKED: 'danger', SOURCE_MISSING: 'neutral' };
const FINANCIAL_TONE = { NEEDS_FINANCIAL_DETAILS: 'warning', LINKED_TO_SALE: 'success', NON_BILLABLE: 'neutral', IGNORED: 'neutral' };

/**
 * Turn a backend enum into a readable sentence-case label: NEEDS_FINANCIAL_DETAILS →
 * "Needs financial details". Sentence case reads better than the `capitalize` transform the base
 * `.bcrm-status` applies, which produced "Needs Financial Details".
 *
 * This is presentation only — the enum values sent to and from the API are untouched.
 */
function statusLabel(value) {
  const words = String(value || '').replace(/_/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—';
}

const emptyFinancials = {
  saleDate: today(),
  orderType: 'new',
  currencyCode: 'PKR',
  vendorId: '',
  salePrice: '',
  purchaseCost: '0.00',
  openingClientPayment: '0.00',
  openingVendorPayment: '0.00',
  paymentMethod: '',
  notes: '',
};

export default function LinkedAccess() {
  const crm = useBusinessCrm();
  const canReconcile = crm.has('website-access.reconcile');
  const canLink = crm.has('website-access.financial-link') && crm.has('sales.create');
  const vendorVisible = crm.has('vendors.view');

  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [financial, setFinancial] = useState('NEEDS_FINANCIAL_DETAILS');
  const [access, setAccess] = useState('');
  const [query, setQuery] = useState('');
  // Search is server-side: the row set is paginated, so filtering in the browser would only ever
  // narrow the current page and would silently miss matches on later pages.
  const search = useDebouncedValue(query);
  const [vendors, setVendors] = useState([]);
  const [editor, setEditor] = useState(null);
  const [form, setForm] = useState(emptyFinancials);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ pageSize: '200' });
      if (financial) params.set('financialStatus', financial);
      if (access) params.set('accessStatus', access);
      if (search) params.set('search', search);
      const response = await crmApi.get(`/access-links?${params.toString()}`);
      setRows(response.data.rows || []);
      setTotal(Number(response.data.total || 0));
      setSummary(response.data.summary || null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }, [financial, access, search]);

  // Reconciliation is best-effort: a failure here must leave the rest of the CRM usable, so it only
  // ever raises a non-blocking warning and the list is loaded either way.
  const reconcile = useCallback(async ({ silent = false } = {}) => {
    if (!canReconcile) return;
    setSyncing(true);
    try {
      const response = await crmApi.post('/access-links/reconcile', {});
      const result = response.data || {};
      if (result.partial) {
        const sources = (result.errors || []).map((entry) => entry.source).filter(Boolean);
        setWarning(`Some website sources could not be read (${[...new Set(sources)].join(', ') || 'unknown'}). Showing everything that did reconcile.`);
      } else if (result.sweepSkipped) {
        setWarning('Reconciliation completed, but the missing-record sweep was skipped because a source was unavailable.');
      } else {
        setWarning('');
      }
    } catch (err) {
      if (!silent) setWarning(`Reconciliation failed: ${messageFromError(err)}. Showing the last known records.`);
    } finally {
      setSyncing(false);
    }
  }, [canReconcile]);

  // On first mount: reconcile, then refresh. Both steps are independent so a failed sweep still
  // renders the stored links.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reconcile({ silent: true });
      if (!cancelled) await load();
    })();
    return () => { cancelled = true; };
  }, [reconcile]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!vendorVisible) return;
    crmApi.get('/contacts/vendors?pageSize=500')
      .then((response) => setVendors(response.data.rows || []))
      .catch(() => setVendors([]));
  }, [vendorVisible]);

  const manualSync = async () => { await reconcile(); await load(); };

  const openEditor = (row) => {
    setEditor(row);
    setForm({
      ...emptyFinancials,
      currencyCode: crm.settings?.default_currency || crm.currency || 'PKR',
      saleDate: row.startDate || today(),
      orderType: 'new',
    });
  };

  const submitFinancials = async () => {
    if (!editor) return;
    setSaving(true);
    setError('');
    try {
      const response = await crmApi.post(`/access-links/${editor.id}/create-financial-record`, {
        clientId: editor.crmClientId,
        vendorId: form.vendorId || null,
        saleDate: form.saleDate,
        orderType: form.orderType,
        currencyCode: form.currencyCode,
        notes: form.notes || null,
        openingClientPayment: form.openingClientPayment || '0.00',
        openingVendorPayment: form.openingVendorPayment || '0.00',
        paymentMethod: form.paymentMethod || null,
        items: [{
          name: editor.toolName,
          accountType: 'private',
          durationLabel: editor.durationDays ? `${editor.durationDays} days` : null,
          salePrice: form.salePrice || '0.00',
          purchaseCost: form.purchaseCost || '0.00',
        }],
      });
      if (response.data && response.data.linked === false) {
        setWarning('The invoice was created, but linking it back to this access record failed. Re-run reconciliation before creating another invoice for it.');
      }
      setEditor(null);
      await load();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (row, action) => {
    setError('');
    try {
      await crmApi.patch(`/access-links/${row.id}/${action}`, {});
      await load();
    } catch (err) {
      setError(messageFromError(err));
    }
  };

  const needsCount = summary?.byFinancial?.NEEDS_FINANCIAL_DETAILS || 0;

  const columns = useMemo(() => [
    { key: 'clientName', label: 'Client', render: (row) => <div><strong>{row.clientName || '—'}</strong><br /><small>{row.clientEmail || '—'}{row.clientPhone ? ` · ${row.clientPhone}` : ''}</small></div> },
    { key: 'toolName', label: 'Tool / service' },
    { key: 'sourceType', label: 'Source', render: (row) => SOURCE_LABELS[row.sourceType] || row.sourceType },
    { key: 'accessMode', label: 'Mode', render: (row) => row.accessMode || '—' },
    { key: 'startDate', label: 'Start', render: (row) => formatDate(row.startDate) },
    { key: 'durationDays', label: 'Duration', render: (row) => (row.durationDays == null ? '—' : `${row.durationDays} days`) },
    { key: 'expiryDate', label: 'Expiry', render: (row) => formatDate(row.expiryDate) },
    { key: 'accessStatus', label: 'Access', render: (row) => <Status tone={ACCESS_TONE[row.accessStatus] || 'neutral'} className="bcrm-linked-access-status">{statusLabel(row.accessStatus)}</Status> },
    { key: 'financialStatus', label: 'Financial', render: (row) => <Status tone={FINANCIAL_TONE[row.financialStatus] || 'neutral'} className="bcrm-linked-access-status">{statusLabel(row.financialStatus)}</Status> },
    {
      key: 'actions',
      label: 'Action',
      render: (row) => {
        if (row.financialStatus === 'LINKED_TO_SALE') return <Status tone="success" className="bcrm-linked-access-status">Invoiced</Status>;
        if (!canLink) return '—';
        // NOTE: deliberately NOT `bcrm-form-actions`. That class picks up a sticky, white,
        // top-bordered footer below 768px, which turned these table-row buttons into a sticky strip
        // inside the card. A page-scoped class keeps the action area static and full width.
        if (row.financialStatus === 'NON_BILLABLE' || row.financialStatus === 'IGNORED') {
          return <div className="bcrm-linked-access-actions">
            <Button variant="ghost" icon={Undo2} onClick={() => setStatus(row, 'reopen')}>Reopen</Button>
          </div>;
        }
        return <div className="bcrm-linked-access-actions">
          <Button icon={Link2} disabled={!row.crmClientId} onClick={() => openEditor(row)}>Complete financial details</Button>
          <Button variant="secondary" icon={Ban} onClick={() => setStatus(row, 'non-billable')}>Mark non-billable</Button>
        </div>;
      },
    },
  ], [canLink]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !rows.length && !query) return <Loading label="Loading website access records…" />;
  if (error && !rows.length) return <ErrorState message={error} onRetry={load} />;

  return <>
    <PageHeader
      title="Website Access"
      description="Access granted through the existing website system, mirrored here so only the financial details need entering. Client, tool and dates stay owned by the access system."
      actions={canReconcile && <Button icon={RefreshCw} disabled={syncing} onClick={manualSync}>{syncing ? 'Reconciling…' : 'Reconcile now'}</Button>}
    />
    {warning && <div className="bcrm-banner warning">{warning}</div>}
    {error && <div className="bcrm-banner warning">{error}</div>}
    <div className="bcrm-banner">
      <BadgeCheck size={15} /> {needsCount} record{needsCount === 1 ? '' : 's'} awaiting financial details. Operational fields are read-only — change access in the existing admin tools.
    </div>
    <div className="bcrm-filterbar">
      <Field label="Financial status"><Select value={financial} onChange={(event) => setFinancial(event.target.value)}>{FINANCIAL_FILTERS.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}</Select></Field>
      <Field label="Access status"><Select value={access} onChange={(event) => setAccess(event.target.value)}>{ACCESS_FILTERS.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}</Select></Field>
      <SearchBox value={query} onChange={setQuery} busy={loading} placeholder="Client, email, phone, tool or source…" />
    </div>
    <Card className="flush" title={`${total || rows.length} access record${(total || rows.length) === 1 ? '' : 's'}`}>
      {rows.length
        ? <Table rows={rows} columns={columns} className="bcrm-linked-access-table" />
        : <Empty
          title={query ? 'No access record matches that search' : 'Nothing to reconcile'}
          description={query ? 'Try a client name, email address, phone number, tool name or source.' : 'Website access records appear here automatically once they exist.'}
        />}
    </Card>

    <Modal
      open={Boolean(editor)}
      title={editor ? `Financial details — ${editor.toolName}` : ''}
      onClose={() => setEditor(null)}
      footer={<><Button variant="secondary" onClick={() => setEditor(null)}>Cancel</Button><Button icon={Link2} disabled={saving} onClick={submitFinancials}>{saving ? 'Creating…' : 'Create invoice & link'}</Button></>}
    >
      {editor && <div className="bcrm-form">
        <div className="bcrm-banner">
          <strong>{editor.clientName || editor.clientEmail || 'Client'}</strong> · {editor.toolName} · {formatDate(editor.startDate)} → {formatDate(editor.expiryDate)}
          {editor.durationDays != null ? ` · ${editor.durationDays} days` : ''}
          <br /><small>These come from the website access record and cannot be edited here.</small>
        </div>
        <div className="bcrm-form-grid">
          <Field label="Invoice date"><Input type="date" value={form.saleDate} onChange={(event) => setForm({ ...form, saleDate: event.target.value })} /></Field>
          <Field label="Order type"><Select value={form.orderType} onChange={(event) => setForm({ ...form, orderType: event.target.value })}><option value="new">New</option><option value="renewal">Renewal</option></Select></Field>
          <Field label="Currency"><Select value={form.currencyCode} onChange={(event) => setForm({ ...form, currencyCode: event.target.value })}>{CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</Select></Field>
          {vendorVisible && <Field label="Vendor"><Select value={form.vendorId} onChange={(event) => setForm({ ...form, vendorId: event.target.value })}><option value="">No vendor</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</Select></Field>}
          <Field label="Sale price" hint="Amount charged to the client"><Input inputMode="decimal" placeholder="0.00" value={form.salePrice} onChange={(event) => setForm({ ...form, salePrice: event.target.value })} /></Field>
          {crm.has('profit.view') && <Field label="Purchase cost" hint="What this access cost you"><Input inputMode="decimal" placeholder="0.00" value={form.purchaseCost} onChange={(event) => setForm({ ...form, purchaseCost: event.target.value })} /></Field>}
          {crm.has('payments.client.record') && <Field label="Amount received" hint="Leave 0.00 if nothing has been paid yet"><Input inputMode="decimal" placeholder="0.00" value={form.openingClientPayment} onChange={(event) => setForm({ ...form, openingClientPayment: event.target.value })} /></Field>}
          {crm.has('payments.vendor.record') && <Field label="Vendor paid"><Input inputMode="decimal" placeholder="0.00" value={form.openingVendorPayment} onChange={(event) => setForm({ ...form, openingVendorPayment: event.target.value })} /></Field>}
          <Field label="Payment method"><Input value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })} placeholder="Cash, bank, JazzCash…" /></Field>
        </div>
        <Field label="Financial notes"><Textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></Field>
      </div>}
    </Modal>
  </>;
}
