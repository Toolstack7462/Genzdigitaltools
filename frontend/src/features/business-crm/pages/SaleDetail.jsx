import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Bell, Edit3, FileText, MessageCircle, RotateCcw, Save, XCircle } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { useResource } from '../hooks';
import { crmPath, formatDate, formatMoney, today } from '../constants';
import { Button, Card, ErrorState, Field, Input, Loading, MessagePreview, Modal, PageHeader, Select, Status, Table, Textarea } from '../components/ui';

export default function SaleDetail() {
  const { id } = useParams();
  const crm = useBusinessCrm();
  const navigate = useNavigate();
  const credentialsVisible = crm.has('credentials.view');
  const resource = useResource(() => `/sales/${id}${credentialsVisible ? '?credentials=1' : ''}`, [id, credentialsVisible]);
  const [payment, setPayment] = useState(null);
  const [reminder, setReminder] = useState(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorState message={resource.error} onRetry={resource.reload} />;
  const sale = resource.data;

  const submitPayment = async () => {
    setWorking(true); setError('');
    try { await crmApi.post(`/payments/sales/${sale.id}`, payment); setPayment(null); await resource.reload(); }
    catch (requestError) { setError(messageFromError(requestError)); }
    finally { setWorking(false); }
  };
  // The prepared message is shown for review first. Opening WhatsApp happens from the dialog's own
  // button, which is a real user gesture and therefore not blocked as a popup.
  const prepareReminder = async (reminderType, entityType = 'sale', entityId = sale.id) => {
    try {
      const response = await crmApi.post('/operations/reminders/prepare', { reminderType, entityType, entityId });
      setReminder(response.data);
    } catch (requestError) { setError(messageFromError(requestError)); }
  };
  const sendReminder = async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    try { await crmApi.post(`/operations/reminders/${reminder.id}/opened`, {}); } catch { /* the message is already open; the audit ping is best effort */ }
    setReminder(null);
  };
  const changeStatus = async (value) => {
    if (!window.confirm(`Change invoice status to ${value}?`)) return;
    try { await crmApi.patch(`/sales/${sale.id}/status`, { status: value }); resource.reload(); }
    catch (requestError) { setError(messageFromError(requestError)); }
  };
  const reversePayment = async (entry) => {
    const reason = window.prompt('Reason for payment reversal');
    if (reason === null) return;
    try { await crmApi.post(`/payments/${entry.id}/reverse`, { reason }); resource.reload(); }
    catch (requestError) { setError(messageFromError(requestError)); }
  };

  const itemColumns = [
    { key: 'name', label: 'Product' }, { key: 'account_type', label: 'Type' }, { key: 'duration_label', label: 'Duration' },
    { key: 'expiry_date', label: 'Expiry', render: (item) => formatDate(item.expiry_date) },
    { key: 'sale_price', label: 'Sale', render: (item) => formatMoney(item.sale_price, sale.currency_code) },
    ...(crm.has('profit.view') ? [{ key: 'purchase_cost', label: 'Cost', render: (item) => formatMoney(item.purchase_cost, sale.currency_code) }] : []),
    ...(credentialsVisible ? [
      { key: 'credential_email', label: 'Login', render: (item) => item.credential_email || (item.has_credential_email ? 'Stored / hidden' : '—') },
      { key: 'credential_password', label: 'Password', render: (item) => item.credential_password || (item.has_credential_password ? 'Stored / hidden' : '—') },
    ] : []),
    ...(crm.has('reminders.prepare') ? [{ key: 'renew', label: 'Reminder', render: (item) => item.expiry_date ? <button className="bcrm-btn bcrm-btn-ghost" onClick={() => prepareReminder('expiry', 'sale_item', item.id)}><Bell size={14} /> Renewal</button> : '—' }] : []),
  ];

  return <>
    <PageHeader title={sale.invoice_number} description={`${sale.client_name} • ${formatDate(sale.sale_date)} • ${sale.currency_code}`} actions={<>
      {crm.has('sales.edit') && <Button variant="secondary" icon={Edit3} onClick={() => navigate(crmPath(`sales/${id}/edit`))}>Edit</Button>}
      {crm.has('invoice.view') && <Button variant="secondary" icon={FileText} onClick={() => window.open(crmApi.rawUrl(`/sales/${sale.id}/invoice.pdf`), '_blank', 'noopener,noreferrer')}>Invoice PDF</Button>}
      {crm.has('invoice.credentials') && credentialsVisible && <Button variant="ghost" icon={FileText} onClick={() => window.open(crmApi.rawUrl(`/sales/${sale.id}/invoice.pdf?credentials=1`), '_blank', 'noopener,noreferrer')}>PDF + access</Button>}
    </>} />
    {error && <div className="bcrm-banner warning">{error}</div>}
    <div className="bcrm-grid bcrm-grid-4">
      <Card title="Invoice total"><strong>{formatMoney(sale.subtotal_sale, sale.currency_code)}</strong></Card>
      <Card title="Client pending"><strong>{formatMoney(sale.client_pending, sale.currency_code)}</strong></Card>
      {crm.has('profit.view') && <Card title="Gross profit"><strong>{formatMoney(sale.gross_profit, sale.currency_code)}</strong></Card>}
      <Card title="Status"><Status tone={sale.status === 'completed' ? 'success' : sale.status === 'cancelled' ? 'danger' : 'warning'}>{sale.status}</Status></Card>
    </div>
    <Card title="Subscriptions & access" subtitle={credentialsVisible ? 'Sensitive credentials are visible because your role explicitly permits access.' : 'Credentials are protected and omitted from this role.'} className="bcrm-section flush">
      <Table rows={sale.items || []} columns={itemColumns} />
    </Card>
    <div className={`bcrm-grid ${crm.has('vendors.view') ? 'bcrm-grid-2' : ''} bcrm-section`}>
      <Card title="Client ledger" subtitle={`${sale.client_name} • ${sale.client_whatsapp || 'No WhatsApp'}`} actions={crm.has('reminders.prepare') && <Button variant="ghost" icon={MessageCircle} onClick={() => prepareReminder('client_pending')}>Reminder</Button>}>
        <div className="bcrm-kv"><div><span>Received</span><strong>{formatMoney(sale.client_paid, sale.currency_code)}</strong></div><div><span>Pending</span><strong>{formatMoney(sale.client_pending, sale.currency_code)}</strong></div></div>
        {crm.has('payments.client.record') && Number(sale.client_pending) > 0 && <div className="bcrm-form-actions"><Button onClick={() => setPayment({ partyType: 'client', amount: sale.client_pending, paymentDate: today(), method: 'Cash', reference: '', notes: '' })}>Record receipt</Button></div>}
      </Card>
      {crm.has('vendors.view') && <Card title="Vendor ledger" subtitle={sale.vendor_name || 'No vendor linked'} actions={crm.has('reminders.prepare') && sale.vendor_id && <Button variant="ghost" icon={MessageCircle} onClick={() => prepareReminder('vendor_due')}>Reminder</Button>}>
        <div className="bcrm-kv"><div><span>Paid</span><strong>{formatMoney(sale.vendor_paid, sale.currency_code)}</strong></div><div><span>Due</span><strong>{formatMoney(sale.vendor_due, sale.currency_code)}</strong></div></div>
        {crm.has('payments.vendor.record') && sale.vendor_id && Number(sale.vendor_due) > 0 && <div className="bcrm-form-actions"><Button onClick={() => setPayment({ partyType: 'vendor', amount: sale.vendor_due, paymentDate: today(), method: 'Bank', reference: '', notes: '' })}>Record vendor payment</Button></div>}
      </Card>}
    </div>
    <Card title="Payment history" subtitle="Reversals preserve the original transaction" className="bcrm-section flush">
      <Table rows={sale.payments || []} columns={[
        { key: 'payment_date', label: 'Date', render: (entry) => formatDate(entry.payment_date) }, { key: 'party_type', label: 'Ledger' },
        { key: 'amount', label: 'Amount', render: (entry) => formatMoney(entry.amount, entry.currency_code) }, { key: 'method', label: 'Method' },
        { key: 'reference', label: 'Reference' }, { key: 'status', label: 'Status', render: (entry) => <Status tone={entry.status === 'posted' ? 'success' : 'danger'}>{entry.status}</Status> },
        { key: 'actions', label: '', render: (entry) => crm.has('payments.reverse') && entry.status === 'posted' && !entry.reverses_payment_id ? <button className="bcrm-btn bcrm-btn-danger" onClick={() => reversePayment(entry)}><RotateCcw size={14} /> Reverse</button> : null },
      ]} />
    </Card>
    <Card title="Internal information" className="bcrm-section">
      <div className="bcrm-kv">
        <div><span>Client</span><strong><Link to={crmPath(`clients/${sale.client_id}`)}>{sale.client_name}</Link></strong></div>
        {crm.has('vendors.view') && <div><span>Vendor</span><strong>{sale.vendor_id ? <Link to={crmPath(`vendors/${sale.vendor_id}`)}>{sale.vendor_name}</Link> : '—'}</strong></div>}
        <div><span>Order type</span><strong>{sale.order_type}</strong></div><div><span>Version</span><strong>{sale.version}</strong></div>
      </div>
      {sale.notes && <p>{sale.notes}</p>}{sale.invoice_instructions && <p><strong>Invoice note:</strong> {sale.invoice_instructions}</p>}
      <div className="bcrm-form-actions">
        {sale.status !== 'cancelled' && crm.has('sales.cancel') && <Button variant="danger" icon={XCircle} onClick={() => changeStatus('cancelled')}>Cancel invoice</Button>}
        {sale.status === 'open' && crm.has('sales.cancel') && <Button variant="secondary" onClick={() => changeStatus('completed')}>Mark completed</Button>}
      </div>
    </Card>
    <Modal open={Boolean(payment)} title={payment?.partyType === 'client' ? 'Record client receipt' : 'Record vendor payment'} onClose={() => setPayment(null)} footer={<><Button variant="secondary" onClick={() => setPayment(null)}>Cancel</Button><Button icon={Save} disabled={working} onClick={submitPayment}>{working ? 'Posting…' : 'Post payment'}</Button></>}>
      {payment && <div className="bcrm-form">
        <Field label="Amount"><Input inputMode="decimal" value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value })} /></Field>
        <Field label="Payment date"><Input type="date" value={payment.paymentDate} onChange={(event) => setPayment({ ...payment, paymentDate: event.target.value })} /></Field>
        <Field label="Method"><Select value={payment.method} onChange={(event) => setPayment({ ...payment, method: event.target.value })}><option>Cash</option><option>Bank</option><option>JazzCash</option><option>Easypaisa</option><option>UPI</option><option>Other</option></Select></Field>
        <Field label="Reference"><Input value={payment.reference} onChange={(event) => setPayment({ ...payment, reference: event.target.value })} /></Field>
        <Field label="Notes"><Textarea value={payment.notes} onChange={(event) => setPayment({ ...payment, notes: event.target.value })} /></Field>
      </div>}
    </Modal>
    <MessagePreview
      open={Boolean(reminder)} title="WhatsApp reminder preview" message={reminder?.message}
      recipient={reminder?.recipient} url={reminder?.url}
      onClose={() => setReminder(null)} onSend={sendReminder}
    />
  </>;
}
