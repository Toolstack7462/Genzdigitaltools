import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search as SearchIcon } from 'lucide-react';
import { useDebouncedValue, useResource } from '../hooks';
import { crmPath, formatDate } from '../constants';
import { Card, ErrorState, Loading, PageHeader, SearchBox, Status } from '../components/ui';

// Every result type maps to the page that owns the record. Types the operator has no permission for
// never reach the browser — the server omits them from the result set entirely.
//
// `segment` returns a bare CRM-relative segment and the JSX wraps it in crmPath() at the point of
// use. Building the absolute path here instead would hide the crmPath() call behind an indirection,
// which the routing guard test rightly refuses to accept as proof the target is absolute.
const TYPES = {
  sale: { label: 'Invoice', tone: 'info', segment: (row) => `sales/${row.id}` },
  client: { label: 'Client', tone: 'success', segment: (row) => `clients/${row.id}` },
  vendor: { label: 'Vendor', tone: 'warning', segment: (row) => `vendors/${row.id}` },
  product: { label: 'Product', tone: 'info', segment: () => 'products' },
  task: { label: 'Task', tone: 'neutral', segment: () => 'tasks' },
  access: { label: 'Website access', tone: 'info', segment: () => 'website-access' },
  expiry: { label: 'Expiry', tone: 'warning', segment: (row) => (row.sale_id ? `sales/${row.sale_id}` : 'expiries') },
  payment: { label: 'Payment', tone: 'success', segment: (row) => (row.sale_id ? `sales/${row.sale_id}` : 'cashbook') },
};
const FALLBACK = { label: 'Record', tone: 'neutral', segment: () => '' };

export default function SearchPage() {
  const [q, setQ] = useState('');
  const term = useDebouncedValue(q);
  const ready = term.trim().length >= 2;
  const resource = useResource(() => `/search?q=${encodeURIComponent(ready ? term : '')}`, [term, ready]);
  const results = resource.data?.results || [];

  return <>
    <PageHeader title="Global search" description="Find invoices, clients, vendors, products, tasks, website access, expiries and payments from one field." />
    <div className="bcrm-filterbar">
      <SearchBox value={q} onChange={setQ} busy={resource.loading && ready} autoFocus label="Search the Business CRM" placeholder="Type at least two characters…" />
    </div>
    {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
    <Card
      className="bcrm-section"
      title={ready ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'Search'}
      subtitle={resource.data?.truncated ? `Showing the ${results.length} most recent of ${resource.data.total} matches — narrow the search to see the rest.` : undefined}
    >
      {/* The spinner sits inside the card so the field above it keeps focus while a search runs. */}
      {resource.loading && ready && !results.length
        ? <Loading label="Searching…" />
        : <div className="bcrm-timeline">
          {results.map((row) => {
            const type = TYPES[row.type] || FALLBACK;
            return <article key={`${row.type}-${row.id}`}>
              <strong><Link to={crmPath(type.segment(row))}>{row.title}</Link></strong>
              <p><Status tone={type.tone}>{type.label}</Status> {row.subtitle} • {formatDate(row.sort_date, true)}</p>
            </article>;
          })}
          {ready && !results.length && !resource.loading && <div className="bcrm-empty">
            <SearchIcon size={30} />
            <strong>No matches</strong>
            <p>Nothing in the modules you can access matches “{term.trim()}”.</p>
          </div>}
          {!ready && <div className="bcrm-empty">
            <SearchIcon size={30} />
            <strong>Start searching</strong>
            <p>Press Ctrl+K from anywhere in the workspace to come back here. Search uses server-side permission filters, so each team member only sees authorized modules.</p>
          </div>}
        </div>}
    </Card>
  </>;
}
