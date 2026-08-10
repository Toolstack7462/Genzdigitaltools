import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Save } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { useResource } from '../hooks';
import { crmPath, formatDate, formatMoney, today } from '../constants';
import { Button, Card, ErrorState, Field, Input, Loading, Modal, PageHeader, SearchBox, Select, Table, Textarea } from '../components/ui';

export default function Payments({ type }) {
  const crm = useBusinessCrm();
  const client = type === 'client';
  const [query, setQuery] = useState('');
  const [entry, setEntry] = useState(null);
  const [error, setError] = useState('');
  const path = client ? '/payments/client-pending' : '/payments/vendor-dues';
  const canPost = crm.has(client ? 'payments.client.record' : 'payments.vendor.record');
  const resource = useResource(() => `${path}?currency=${crm.currency}&q=${encodeURIComponent(query)}`, [path, crm.currency, query]);

  const submit = async () => {
    try { await crmApi.post(`/payments/sales/${entry.saleId}`, entry); setEntry(null); setError(''); resource.reload(); }
    catch (requestError) { setError(messageFromError(requestError)); }
  };
  const remind = async (row) => {
    try {
      const response = await crmApi.post('/operations/reminders/prepare', { reminderType: client ? 'client_pending' : 'vendor_due', entityType: 'sale', entityId: row.id });
      window.open(response.data.url, '_blank', 'noopener,noreferrer');
      await crmApi.post(`/operations/reminders/${response.data.id}/opened`, {});
    } catch (requestError) { setError(messageFromError(requestError)); }
  };

  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorState message={resource.error} onRetry={resource.reload} />;

  return <>
    <PageHeader title={client ? 'Client pending payments' : 'Vendor dues'} description={client ? 'Outstanding receivables with installment posting and WhatsApp reminders.' : 'Outstanding supplier liabilities with controlled payment posting.'} />
    {error && <div className="bcrm-banner warning">{error}</div>}
    <div className="bcrm-filterbar"><SearchBox value={query} onChange={setQuery} placeholder="Name, phone or invoice…" /></div>
    <Card className="flush"><Table rows={resource.data?.rows || []} columns={[
      { key: 'invoice_number', label: 'Invoice', render: (row) => <Link to={crmPath(`sales/${row.id}`)}>{row.invoice_number}</Link> },
      { key: 'party_name', label: client ? 'Client' : 'Vendor' }, { key: 'sale_date', label: 'Date', render: (row) => formatDate(row.sale_date) },
      { key: 'total_amount', label: 'Total', render: (row) => formatMoney(row.total_amount, row.currency_code) }, { key: 'paid_amount', label: 'Paid', render: (row) => formatMoney(row.paid_amount, row.currency_code) },
      { key: 'pending_amount', label: client ? 'Pending' : 'Due', render: (row) => <strong>{formatMoney(row.pending_amount, row.currency_code)}</strong> },
      { key: 'actions', label: 'Actions', render: (row) => <div className="bcrm-actions">
        {canPost && <Button variant="secondary" onClick={() => setEntry({ saleId: row.id, partyType: type, amount: row.pending_amount, paymentDate: today(), method: client ? 'Cash' : 'Bank', reference: '', notes: '' })}>Post payment</Button>}
        {crm.has('reminders.prepare') && <Button variant="ghost" icon={MessageCircle} onClick={() => remind(row)}>Reminder</Button>}
      </div> },
    ]} /></Card>
    <Modal open={Boolean(entry)} title={client ? 'Record client receipt' : 'Record vendor payment'} onClose={() => setEntry(null)} footer={<><Button variant="secondary" onClick={() => setEntry(null)}>Cancel</Button><Button icon={Save} onClick={submit}>Post payment</Button></>}>
      {entry && <div className="bcrm-form">
        <Field label="Amount"><Input inputMode="decimal" value={entry.amount} onChange={(event) => setEntry({ ...entry, amount: event.target.value })} /></Field>
        <Field label="Date"><Input type="date" value={entry.paymentDate} onChange={(event) => setEntry({ ...entry, paymentDate: event.target.value })} /></Field>
        <Field label="Method"><Select value={entry.method} onChange={(event) => setEntry({ ...entry, method: event.target.value })}><option>Cash</option><option>Bank</option><option>JazzCash</option><option>Easypaisa</option><option>UPI</option><option>Other</option></Select></Field>
        <Field label="Reference"><Input value={entry.reference} onChange={(event) => setEntry({ ...entry, reference: event.target.value })} /></Field>
        <Field label="Notes"><Textarea value={entry.notes} onChange={(event) => setEntry({ ...entry, notes: event.target.value })} /></Field>
      </div>}
    </Modal>
  </>;
}
