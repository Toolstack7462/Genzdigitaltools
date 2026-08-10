import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Save } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { useDebouncedValue, useResource } from '../hooks';
import { crmPath, formatDate, formatMoney, today } from '../constants';
import { Button, Card, ErrorState, Field, Input, Loading, MessagePreview, Modal, PageHeader, SearchBox, Select, Table, Textarea } from '../components/ui';

export default function Payments({ type }) {
  const crm = useBusinessCrm();
  const client = type === 'client';
  const [query, setQuery] = useState('');
  const [entry, setEntry] = useState(null);
  const [reminder, setReminder] = useState(null);
  const [error, setError] = useState('');
  const path = client ? '/payments/client-pending' : '/payments/vendor-dues';
  const canPost = crm.has(client ? 'payments.client.record' : 'payments.vendor.record');
  const debounced = useDebouncedValue(query);
  const resource = useResource(() => `${path}?pageSize=100&currency=${crm.currency}&q=${encodeURIComponent(debounced)}`, [path, crm.currency, debounced]);

  const submit = async () => {
    try { await crmApi.post(`/payments/sales/${entry.saleId}`, entry); setEntry(null); setError(''); resource.reload(); }
    catch (requestError) { setError(messageFromError(requestError)); }
  };
  // Preview first, then open WhatsApp from the dialog button so the popup is tied to a user gesture.
  const remind = async (row) => {
    if (Number(row.pending_amount ?? 0) <= 0) { setError('That invoice has no outstanding balance, so no payment reminder was prepared.'); return; }
    try {
      const response = await crmApi.post('/operations/reminders/prepare', { reminderType: client ? 'client_pending' : 'vendor_due', entityType: 'sale', entityId: row.id });
      setReminder(response.data);
    } catch (requestError) {
      setError(messageFromError(requestError));
      // The row was settled elsewhere: reload so the list stops offering a reminder for it.
      if (requestError?.response?.data?.code === 'REMINDER_NOT_PAYABLE') resource.reload();
    }
  };
  const sendReminder = async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    try { await crmApi.post(`/operations/reminders/${reminder.id}/opened`, {}); } catch { /* best effort */ }
    setReminder(null);
  };

  if (resource.initialLoading) return <Loading />;
  if (resource.error) return <ErrorState message={resource.error} onRetry={resource.reload} />;

  return <>
    <PageHeader title={client ? 'Client pending payments' : 'Vendor dues'} description={client ? 'Outstanding receivables with installment posting and WhatsApp reminders.' : 'Outstanding supplier liabilities with controlled payment posting.'} />
    {error && <div className="bcrm-banner warning">{error}</div>}
    <div className="bcrm-filterbar"><SearchBox value={query} onChange={setQuery} busy={resource.loading} placeholder="Name, phone, email or invoice…" /></div>
    <Card className="flush"><Table rows={resource.data?.rows || []} columns={[
      { key: 'invoice_number', label: 'Invoice', render: (row) => <Link to={crmPath(`sales/${row.id}`)}>{row.invoice_number}</Link> },
      { key: 'party_name', label: client ? 'Client' : 'Vendor' }, { key: 'sale_date', label: 'Date', render: (row) => formatDate(row.sale_date) },
      { key: 'total_amount', label: 'Total', render: (row) => formatMoney(row.total_amount, row.currency_code) }, { key: 'paid_amount', label: 'Paid', render: (row) => formatMoney(row.paid_amount, row.currency_code) },
      { key: 'pending_amount', label: client ? 'Pending' : 'Due', render: (row) => <strong>{formatMoney(row.pending_amount, row.currency_code)}</strong> },
      { key: 'actions', label: 'Actions', render: (row) => <div className="bcrm-actions">
        {canPost && <Button variant="secondary" onClick={() => setEntry({ saleId: row.id, partyType: type, amount: row.pending_amount, paymentDate: today(), method: client ? 'Cash' : 'Bank', reference: '', notes: '' })}>Post payment</Button>}
        {crm.has('reminders.prepare') && Number(row.pending_amount ?? 0) > 0 && <Button variant="ghost" icon={MessageCircle} onClick={() => remind(row)}>Reminder</Button>}
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
    <MessagePreview
      open={Boolean(reminder)} title={client ? 'Payment reminder preview' : 'Vendor payment reminder preview'}
      message={reminder?.message} recipient={reminder?.recipient} url={reminder?.url}
      onClose={() => setReminder(null)} onSend={sendReminder}
    />
  </>;
}
