import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Save } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { crmApi, messageFromError } from '../api';
import { useDebouncedValue, useResource } from '../hooks';
import { crmPath, formatDate, formatMoney, today } from '../constants';
import { Button, Card, ErrorState, Field, Input, Loading, MessagePreview, Modal, PageHeader, Pager, SearchBox, Select, Table, Textarea } from '../components/ui';

/** Outstanding minus the amount being entered. Pure display; the server stays authoritative. */
function proposedBalance(entry) {
  const pending = Number(entry?.context?.pending ?? 0);
  const amount = Number(entry?.amount ?? 0);
  if (!Number.isFinite(pending) || !Number.isFinite(amount)) return entry?.context?.pending ?? '0';
  return (Math.round((pending - amount) * 100) / 100).toFixed(2);
}

export default function Payments({ type }) {
  const crm = useBusinessCrm();
  const client = type === 'client';
  const [query, setQuery] = useState('');
  const [entry, setEntry] = useState(null);
  const [reminder, setReminder] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [posting, setPosting] = useState(false);
  // An attempt whose outcome we do not know (no response / server error). The payment may or may
  // not exist. Until it is resolved the form is locked, so a second, DIFFERENT payment cannot be
  // created by accident; the only forward actions are retrying the SAME key or deliberately
  // starting a new payment.
  const [unresolved, setUnresolved] = useState(null);
  // Set synchronously, before any await. `disabled` on the button is repainted a frame later, so
  // on its own it does not stop a fast double-click from entering submit twice.
  const inFlight = useRef(false);
  const path = client ? '/payments/client-pending' : '/payments/vendor-dues';
  const canPost = crm.has(client ? 'payments.client.record' : 'payments.vendor.record');
  const debounced = useDebouncedValue(query);
  const [page, setPage] = useState(1);
  // Path (client/vendor), currency and search each define a different result set, so the cursor
  // from the previous one is meaningless.
  useEffect(() => { setPage(1); }, [path, crm.currency, debounced]);
  const resource = useResource(() => `${path}?page=${page}&pageSize=25&currency=${crm.currency}&q=${encodeURIComponent(debounced)}`, [path, crm.currency, debounced, page]);
  // A settled invoice leaves the outstanding list between loads; step back off an emptied page.
  useEffect(() => {
    const total = Number(resource.data?.total ?? 0); const size = Number(resource.data?.pageSize ?? 25);
    if (!resource.loading && total > 0 && page > 1 && (page - 1) * size >= total) setPage(Math.max(1, Math.ceil(total / size)));
  }, [resource.data, resource.loading, page]);

  // One intended payment gets ONE key, minted when the dialog opens and re-minted whenever the
  // operator changes what they are paying. That matters because of the server's replay rule
  // (services/paymentService.js): a repeated key is treated as the same operation when the actor,
  // sale, party type and AMOUNT match - paymentDate, method, reference and notes are NOT compared.
  // So reusing a key after editing the method would replay the original row and silently drop the
  // edit, and the endpoint would still answer 201. Re-minting on edit keeps the key tied to the
  // exact payload it was created for.
  const newKey = () => {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (_) { /* fall through */ }
    return `pay-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  };

  const openEntry = (row) => {
    setError(''); setNotice(''); setUnresolved(null);
    setEntry({
      saleId: row.id, partyType: type, amount: row.pending_amount, paymentDate: today(),
      method: client ? 'Cash' : 'Bank', reference: '', notes: '', idempotencyKey: newKey(),
      context: { invoice: row.invoice_number, party: row.party_name, currency: row.currency_code, pending: row.pending_amount, paid: row.paid_amount, total: row.total_amount },
    });
  };

  // Editing is refused while an attempt is unresolved: changing the payload would need a new key,
  // and a new key after a possibly-committed payment is how one intended payment becomes two.
  const editEntry = (patch) => setEntry((current) => (current && !unresolved ? { ...current, ...patch, idempotencyKey: newKey() } : current));

  const post = async (keyOverride) => {
    if (inFlight.current || !entry) return;
    inFlight.current = true; setPosting(true); setError('');
    const payload = {
      partyType: entry.partyType, amount: entry.amount, paymentDate: entry.paymentDate,
      method: entry.method, reference: entry.reference, notes: entry.notes,
      idempotencyKey: keyOverride || entry.idempotencyKey,
    };
    try {
      const response = await crmApi.post(`/payments/sales/${entry.saleId}`, payload);
      setUnresolved(null);
      // The server tells us when it reconciled instead of posting. Saying "saved" here would be a
      // lie: on a replay the stored date/method/reference/notes are the ORIGINAL ones.
      setNotice(response?.data?.replayed
        ? 'Already recorded - reconciled to the original payment, not posted twice. Any edits to date, method, reference or notes were not applied to it.'
        : 'Payment recorded.');
      setEntry(null);          // cleared only after a confirmed outcome
      resource.reload();
    } catch (requestError) {
      const status = requestError?.response?.status;
      if (status === undefined || status >= 500) {
        // No usable answer: the write may already be committed. Keep the key and the payload.
        setUnresolved({ key: payload.idempotencyKey });
        setError('The result of that payment is unknown - it may already be recorded. Use Retry to check with the same operation key; do not re-enter it.');
      } else {
        setError(messageFromError(requestError));   // a definite refusal; entered values are kept
      }
    } finally { inFlight.current = false; setPosting(false); }
  };

  const submit = () => post();
  const retrySameOperation = () => post(unresolved && unresolved.key);
  const startReplacement = () => { setUnresolved(null); setError(''); setEntry((current) => (current ? { ...current, idempotencyKey: newKey() } : current)); };
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
    {error && <div className="bcrm-banner warning" role="alert">{error}</div>}
    {notice && <div className="bcrm-banner" role="status">{notice}</div>}
    <div className="bcrm-filterbar"><SearchBox value={query} onChange={setQuery} busy={resource.loading} placeholder="Name, phone, email or invoice…" /></div>
    <Card className="flush"><Table rows={resource.data?.rows || []} columns={[
      { key: 'invoice_number', label: 'Invoice', render: (row) => <Link to={crmPath(`sales/${row.id}`)}>{row.invoice_number}</Link> },
      { key: 'party_name', label: client ? 'Client' : 'Vendor' }, { key: 'sale_date', label: 'Date', render: (row) => formatDate(row.sale_date) },
      { key: 'total_amount', label: 'Total', render: (row) => formatMoney(row.total_amount, row.currency_code) }, { key: 'paid_amount', label: 'Paid', render: (row) => formatMoney(row.paid_amount, row.currency_code) },
      { key: 'pending_amount', label: client ? 'Pending' : 'Due', render: (row) => <strong>{formatMoney(row.pending_amount, row.currency_code)}</strong> },
      { key: 'actions', label: 'Actions', render: (row) => <div className="bcrm-actions">
        {canPost && <Button variant="secondary" onClick={() => openEntry(row)}>Post payment</Button>}
        {crm.has('reminders.prepare') && Number(row.pending_amount ?? 0) > 0 && <Button variant="ghost" icon={MessageCircle} onClick={() => remind(row)}>Reminder</Button>}
      </div> },
    ]} /><Pager page={resource.data?.page} pageSize={resource.data?.pageSize} total={resource.data?.total} shown={resource.data?.rows?.length} busy={resource.loading} onPage={setPage} noun={client ? 'pending invoices' : 'vendor dues'}/></Card>
    <Modal
      open={Boolean(entry)}
      title={client ? 'Record client receipt' : 'Record vendor payment'}
      onClose={() => { if (!posting && !unresolved) { setEntry(null); setError(''); } }}
      footer={unresolved
        ? <><Button variant="secondary" onClick={startReplacement} disabled={posting}>Start a new payment</Button><Button icon={Save} onClick={retrySameOperation} disabled={posting}>{posting ? 'Checking…' : 'Retry same payment'}</Button></>
        : <><Button variant="secondary" onClick={() => setEntry(null)} disabled={posting}>Cancel</Button><Button icon={Save} onClick={submit} disabled={posting}>{posting ? 'Posting…' : 'Post payment'}</Button></>}
    >
      {entry && <div className="bcrm-form">
        {/* What is actually being paid, and what it leaves behind. Posting a figure without the
            invoice, the party, the currency and the resulting balance in view is how the wrong
            amount gets entered against the right invoice. */}
        <div className="bcrm-paycontext">
          <p><span>{client ? 'Client' : 'Vendor'}</span><strong>{entry.context.party}</strong></p>
          <p><span>Invoice</span><strong>{entry.context.invoice}</strong></p>
          <p><span>Outstanding now</span><strong>{formatMoney(entry.context.pending, entry.context.currency)}</strong></p>
          <p><span>After this payment</span><strong>{formatMoney(proposedBalance(entry), entry.context.currency)}</strong></p>
        </div>
        {unresolved && <div className="bcrm-banner warning" role="status">Outcome unknown. Retry re-sends the same operation key, so an already-recorded payment is reconciled instead of duplicated. The fields are locked until this is resolved.</div>}
        <Field label="Amount"><Input inputMode="decimal" value={entry.amount} disabled={Boolean(unresolved) || posting} onChange={(event) => editEntry({ amount: event.target.value })} /></Field>
        <Field label="Date"><Input type="date" value={entry.paymentDate} disabled={Boolean(unresolved) || posting} onChange={(event) => editEntry({ paymentDate: event.target.value })} /></Field>
        <Field label="Method"><Select value={entry.method} disabled={Boolean(unresolved) || posting} onChange={(event) => editEntry({ method: event.target.value })}><option>Cash</option><option>Bank</option><option>JazzCash</option><option>Easypaisa</option><option>UPI</option><option>Other</option></Select></Field>
        <Field label="Reference"><Input value={entry.reference} disabled={Boolean(unresolved) || posting} onChange={(event) => editEntry({ reference: event.target.value })} /></Field>
        <Field label="Notes"><Textarea value={entry.notes} disabled={Boolean(unresolved) || posting} onChange={(event) => editEntry({ notes: event.target.value })} /></Field>
      </div>}
    </Modal>
    <MessagePreview
      open={Boolean(reminder)} title={client ? 'Payment reminder preview' : 'Vendor payment reminder preview'}
      message={reminder?.message} recipient={reminder?.recipient} url={reminder?.url}
      onClose={() => setReminder(null)} onSend={sendReminder}
    />
  </>;
}
