import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MessageSquarePlus, Save } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { useResource } from '../hooks';
import { crmPath, formatDate, formatMoney } from '../constants';
import { Button, Card, ErrorState, Field, Input, Loading, PageHeader, Select, Status, Table, Textarea } from '../components/ui';

export default function ContactDetail({ kind }) {
  const { id } = useParams();
  const crm = useBusinessCrm();
  const singular = kind === 'clients' ? 'client' : 'vendor';
  const resource = useResource(() => `/contacts/${kind}/${id}`, [kind, id]);
  const [form, setForm] = useState(null);
  const [activity, setActivity] = useState({ activityType: 'note', subject: '', body: '' });
  const [error, setError] = useState('');
  const canEdit = crm.has(`${kind}.edit`);
  const canAddActivity = crm.has('activities.manage');

  useEffect(() => {
    if (resource.data) setForm({ name: resource.data.name, whatsapp: resource.data.whatsapp || '', email: resource.data.email || '', company: resource.data.company || '', address: resource.data.address || '', taxId: resource.data.tax_id || '', notes: resource.data.notes || '', status: resource.data.status, version: resource.data.version });
  }, [resource.data]);

  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorState message={resource.error} onRetry={resource.reload} />;

  const data = resource.data;
  const save = async () => {
    try { await crmApi.put(`/contacts/${kind}/${id}`, form); setError(''); resource.reload(); }
    catch (requestError) { setError(messageFromError(requestError)); }
  };
  const addActivity = async () => {
    try { await crmApi.post('/operations/activities', { entityType: singular, entityId: id, ...activity }); setActivity({ activityType: 'note', subject: '', body: '' }); setError(''); resource.reload(); }
    catch (requestError) { setError(messageFromError(requestError)); }
  };

  const financialColumns = singular === 'client' ? [
    { key: 'invoice_number', label: 'Invoice', render: (sale) => <Link to={crmPath(`sales/${sale.id}`)}>{sale.invoice_number}</Link> },
    { key: 'sale_date', label: 'Date', render: (sale) => formatDate(sale.sale_date) },
    { key: 'currency_code', label: 'Currency' },
    { key: 'subtotal_sale', label: 'Sale', render: (sale) => formatMoney(sale.subtotal_sale, sale.currency_code) },
    { key: 'client_paid', label: 'Received', render: (sale) => formatMoney(sale.client_paid, sale.currency_code) },
    ...(crm.has('profit.view') ? [{ key: 'gross_profit', label: 'Profit', render: (sale) => formatMoney(sale.gross_profit, sale.currency_code) }] : []),
    { key: 'status', label: 'Status', render: (sale) => <Status>{sale.status}</Status> },
  ] : [
    { key: 'invoice_number', label: 'Invoice', render: (sale) => <Link to={crmPath(`sales/${sale.id}`)}>{sale.invoice_number}</Link> },
    { key: 'sale_date', label: 'Date', render: (sale) => formatDate(sale.sale_date) },
    { key: 'currency_code', label: 'Currency' },
    { key: 'subtotal_cost', label: 'Purchase', render: (sale) => formatMoney(sale.subtotal_cost, sale.currency_code) },
    { key: 'vendor_paid', label: 'Paid', render: (sale) => formatMoney(sale.vendor_paid, sale.currency_code) },
    ...(crm.has('profit.view') ? [{ key: 'gross_profit', label: 'Related profit', render: (sale) => formatMoney(sale.gross_profit, sale.currency_code) }] : []),
    { key: 'status', label: 'Status', render: (sale) => <Status>{sale.status}</Status> },
  ];

  return <>
    <PageHeader title={data.name} description={`${singular} CRM profile • ${data.company || 'Independent'}`} />
    {error && <div className="bcrm-banner warning">{error}</div>}
    <div className="bcrm-grid bcrm-grid-3">
      {(data.totals || []).map((total) => <Card key={total.currency_code} title={`${total.currency_code} relationship`}><div className="bcrm-kv"><div><span>Total</span><strong>{formatMoney(total.total_amount, total.currency_code)}</strong></div><div><span>{singular === 'client' ? 'Received' : 'Paid'}</span><strong>{formatMoney(total.paid_amount, total.currency_code)}</strong></div><div><span>{singular === 'client' ? 'Pending' : 'Due'}</span><strong>{formatMoney(total.pending_amount, total.currency_code)}</strong></div><div><span>Invoices</span><strong>{total.sale_count}</strong></div></div></Card>)}
    </div>
    <div className={`bcrm-grid ${canAddActivity ? 'bcrm-grid-2' : ''} bcrm-section`}>
      <Card title="Profile information" actions={canEdit && <Button icon={Save} onClick={save}>Save profile</Button>}>
        {form && <div className="bcrm-form-grid">
          <Field label="Name"><Input disabled={!canEdit} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="WhatsApp"><Input disabled={!canEdit} value={form.whatsapp} onChange={(event) => setForm({ ...form, whatsapp: event.target.value })} /></Field>
          <Field label="Email"><Input disabled={!canEdit} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          <Field label="Company"><Input disabled={!canEdit} value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></Field>
          <Field label="Status"><Select disabled={!canEdit} value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="active">Active</option><option value="inactive">Inactive</option></Select></Field>
          <Field label="Address"><Textarea disabled={!canEdit} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></Field>
          <Field label="Notes"><Textarea disabled={!canEdit} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></Field>
        </div>}
      </Card>
      {canAddActivity && <Card title="Add CRM activity" subtitle="Notes, calls, emails, meetings and reminders"><div className="bcrm-form">
        <Field label="Type"><Select value={activity.activityType} onChange={(event) => setActivity({ ...activity, activityType: event.target.value })}><option value="note">Note</option><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="reminder">Reminder</option></Select></Field>
        <Field label="Subject"><Input value={activity.subject} onChange={(event) => setActivity({ ...activity, subject: event.target.value })} /></Field>
        <Field label="Details"><Textarea value={activity.body} onChange={(event) => setActivity({ ...activity, body: event.target.value })} /></Field>
        <Button icon={MessageSquarePlus} onClick={addActivity}>Add activity</Button>
      </div></Card>}
    </div>
    <Card title="Financial history" className="bcrm-section flush"><Table rows={data.sales || []} columns={financialColumns} /></Card>
    <div className="bcrm-grid bcrm-grid-2 bcrm-section">
      <Card title="Activities"><div className="bcrm-timeline">{(data.activities || []).map((entry) => <article key={entry.id}><strong>{entry.subject || entry.activity_type}</strong><p>{entry.body || 'No details'} • {formatDate(entry.created_at, true)}</p></article>)}</div></Card>
      <Card title="Tasks"><Table rows={data.tasks || []} columns={[{ key: 'title', label: 'Task' }, { key: 'priority', label: 'Priority' }, { key: 'due_at', label: 'Due', render: (task) => formatDate(task.due_at, true) }, { key: 'status', label: 'Status', render: (task) => <Status>{task.status}</Status> }]} /></Card>
    </div>
  </>;
}
