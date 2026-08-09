import { NavLink, Outlet } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { CURRENCIES, CURRENCY_LABELS, NAV } from './constants';
import { useBusinessCrm } from './BusinessCrmContext';
import { Button, ErrorState, Loading } from './components/ui';
export default function BusinessCrmLayout() {
  const crm = useBusinessCrm();
  if (crm.loading) return <div className="bcrm-root"><Loading label="Opening Gen Z Business Console…"/></div>;
  if (crm.error) return <div className="bcrm-root"><ErrorState message={crm.error} onRetry={crm.reloadBootstrap}/></div>;
  return <div className="bcrm-root"><div className="bcrm-shell">
    <aside className="bcrm-subnav"><div className="bcrm-subnav-head"><strong>Business CRM</strong><span>{crm.role || 'Team workspace'}</span></div><nav className="bcrm-nav" aria-label="Business CRM navigation">
      {NAV.filter(([, , , permission]) => crm.has(permission)).map(([label, path, icon]) => { const Icon = Icons[icon] || Icons.Circle; return <NavLink key={label} to={path} end={!path}><Icon size={16}/><span>{label}</span></NavLink>; })}
    </nav></aside>
    <section className="bcrm-content"><header className="bcrm-toolbar"><div className="bcrm-toolbar-group"><label htmlFor="business-currency">Reporting currency</label><select id="business-currency" value={crm.currency} onChange={(event) => crm.setCurrency(event.target.value)}>{CURRENCIES.map((currency) => <option value={currency} key={currency}>{currency} — {CURRENCY_LABELS[currency]}</option>)}</select></div><div className="bcrm-toolbar-group"><span className={`bcrm-connect ${crm.online ? '' : 'offline'}`}><Icons.Wifi size={14}/><span>{crm.online ? 'Online' : 'Offline'}</span>{crm.queued > 0 && ` • ${crm.queued} queued`}</span>{crm.queued > 0 && crm.online && <Button variant="ghost" onClick={crm.runSync} disabled={crm.syncing} icon={crm.syncing ? Icons.LoaderCircle : Icons.RefreshCw}>{crm.syncing ? 'Syncing' : 'Sync now'}</Button>}</div></header><main className="bcrm-main"><Outlet/></main></section>
  </div></div>;
}
