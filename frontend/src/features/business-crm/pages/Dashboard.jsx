import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Plus, RefreshCw } from 'lucide-react';
import { useBusinessCrm } from '../BusinessCrmContext';
import { useResource } from '../hooks';
import { crmPath, formatDate, formatMoney } from '../constants';
import { Button, Card, ErrorState, Loading, Metric, PageHeader, Status, Table } from '../components/ui';

export default function Dashboard() {
  const crm = useBusinessCrm();
  const navigate = useNavigate();
  const resource = useResource(() => `/dashboard?currency=${crm.currency}`, [crm.currency]);

  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorState message={resource.error} onRetry={resource.reload} />;

  const data = resource.data || {};
  const metrics = [
    ['Today sales', data.today?.sales, 'blue', `${data.today?.saleCount || 0} invoices`],
    ['Today received', data.today?.received, 'cyan', 'Actual collections'],
    ['Monthly sales', data.monthSummary?.sales, 'teal', data.month],
    ['Client pending', data.outstanding?.clientPending, 'amber', 'Outstanding receivables'],
  ];
  if (data.outstanding?.vendorDue !== undefined) metrics.push(['Vendor dues', data.outstanding.vendorDue, 'red', 'Outstanding payables']);
  if (data.monthSummary?.grossProfit !== undefined) metrics.push(['Gross profit', data.monthSummary.grossProfit, 'green', 'Before operating expenses']);
  if (data.monthSummary?.expenses !== undefined) metrics.push(['Monthly expenses', data.monthSummary.expenses, 'amber', 'Operating expenses']);
  if (data.monthSummary?.netProfit !== undefined) metrics.push(['Net profit', data.monthSummary.netProfit, 'green', 'After expenses']);

  return <>
    <PageHeader
      title="Business command centre"
      description="Sales, collections, liabilities and follow-ups in one live workspace."
      actions={<>
        <Button variant="secondary" icon={RefreshCw} onClick={resource.reload}>Refresh</Button>
        {crm.has('sales.create') && <Button icon={Plus} onClick={() => navigate(crmPath('sales/new'))}>New sale</Button>}
      </>}
    />
    {!crm.online && <div className="bcrm-banner warning">Offline mode: figures below are the last server response. Confirmed balances require synchronization.</div>}
    <div className="bcrm-grid bcrm-grid-4">
      {metrics.map(([label, value, tone, hint]) => <Metric key={label} label={label} value={value ?? '0.00'} currency={crm.currency} tone={tone} hint={hint} />)}
    </div>
    <div className="bcrm-grid bcrm-grid-2 bcrm-section">
      <Card title="Recent sales" subtitle="Latest invoices in selected currency" className="flush" actions={<Link className="bcrm-btn bcrm-btn-ghost" to={crmPath('sales')}>View all <ArrowRight size={14} /></Link>}>
        <Table
          rows={data.recentSales || []}
          columns={[
            { key: 'invoice_number', label: 'Invoice', render: (row) => <Link to={crmPath(`sales/${row.id}`)} onClick={(event) => event.stopPropagation()}>{row.invoice_number}</Link> },
            { key: 'client_name', label: 'Client' },
            { key: 'sale_date', label: 'Date', render: (row) => formatDate(row.sale_date) },
            { key: 'subtotal_sale', label: 'Total', render: (row) => formatMoney(row.subtotal_sale, row.currency_code) },
            { key: 'client_paid', label: 'Received', render: (row) => formatMoney(row.client_paid, row.currency_code) },
          ]}
          onRow={(row) => navigate(crmPath(`sales/${row.id}`))}
        />
      </Card>
      <Card title="Top products" subtitle="Current month performance" className="flush">
        <Table rows={data.topProducts || []} columns={[
          { key: 'name', label: 'Product' },
          { key: 'units', label: 'Units' },
          { key: 'revenue', label: 'Revenue', render: (row) => formatMoney(row.revenue, crm.currency) },
          ...(data.topProducts?.[0]?.profit !== undefined ? [{ key: 'profit', label: 'Profit', render: (row) => formatMoney(row.profit, crm.currency) }] : []),
        ]} />
      </Card>
    </div>
    <div className={`bcrm-grid ${crm.has('audit.view') ? 'bcrm-grid-2' : ''} bcrm-section`}>
      <Card title="Team follow-ups" subtitle="Tasks assigned to you">
        <div className="bcrm-grid bcrm-grid-2">
          <Metric label="Open tasks" value={data.tasks?.open || 0} tone="blue" />
          <Metric label="Overdue" value={data.tasks?.overdue || 0} tone={data.tasks?.overdue ? 'red' : 'green'} />
        </div>
        <div className="bcrm-form-actions"><Link className="bcrm-btn bcrm-btn-secondary" to={crmPath('tasks')}>Open task board</Link></div>
      </Card>
      {crm.has('audit.view') && <Card title="Recent activity" subtitle="Immutable financial and operational audit trail">
        <div className="bcrm-timeline">
          {(data.activities || []).slice(0, 6).map((row) => <article key={`${row.created_at}-${row.entity_id}`}><strong>{String(row.action_key || 'activity').replaceAll('.', ' ')}</strong><p>{row.entity_type || 'system'} • {formatDate(row.created_at, true)}</p></article>)}
          {!data.activities?.length && <Status>No recent activity</Status>}
        </div>
      </Card>}
    </div>
  </>;
}
