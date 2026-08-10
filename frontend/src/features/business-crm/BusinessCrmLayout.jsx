import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { CURRENCIES, CURRENCY_LABELS, MOBILE_QUICK_NAV, NAV, NAV_GROUPS, crmPath } from './constants';
import { useBusinessCrm } from './BusinessCrmContext';
import { Button, ErrorState, Loading } from './components/ui';

/**
 * CRM workspace shell.
 *
 * Every navigation target goes through crmPath() so it is ABSOLUTE. Relative targets were the
 * cause of the accumulated-URL bug: React Router resolves them against the active route branch,
 * so clicking a sibling from an already-nested URL appended a segment instead of replacing it.
 *
 * Layout contract (one full text sidebar at a time — the Admin rail collapses via
 * `body.crm-workspace`, set below and scoped to /admin/business/*):
 *   >= 1280px  compact Admin icon rail + CRM sidebar + content
 *   1024-1279  Admin sidebar hidden + CRM sidebar + "Back to Admin Console" in the toolbar
 *   < 1024px   no permanent sidebar; a focus-trapped drawer plus a compact quick-nav bar
 */

const DRAWER_BREAKPOINT = 1024;

function iconFor(name) {
  return Icons[name] || Icons.Circle;
}

export default function BusinessCrmLayout() {
  const crm = useBusinessCrm();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef(null);
  const menuButtonRef = useRef(null);

  const visible = useMemo(() => NAV.filter((entry) => crm.has(entry.permission)), [crm]);
  const grouped = useMemo(
    () => NAV_GROUPS
      .map((group) => ({ group, items: visible.filter((entry) => entry.group === group) }))
      .filter((section) => section.items.length > 0),
    [visible],
  );
  const quickNav = useMemo(
    () => MOBILE_QUICK_NAV.filter((entry) => crm.has(entry.permission)),
    [crm],
  );

  // Mark the document while the CRM is mounted so the global Admin chrome can collapse to an icon
  // rail. Scoped to this component's lifetime, so every other Admin page is untouched.
  useEffect(() => {
    document.body.classList.add('crm-workspace');
    return () => document.body.classList.remove('crm-workspace');
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    // Return focus to the trigger so keyboard users are not dropped at the top of the document.
    if (menuButtonRef.current) menuButtonRef.current.focus();
  }, []);

  // The drawer is a modal surface: Escape closes it, focus is trapped, body scroll is locked
  // only while it is open, and any route change dismisses it.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = drawerRef.current.querySelectorAll('a[href], button:not([disabled]), select, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const firstLink = drawerRef.current && drawerRef.current.querySelector('a[href], button:not([disabled])');
    if (firstLink) firstLink.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen, closeDrawer]);

  // Close on navigation, and whenever the viewport grows past the drawer breakpoint.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= DRAWER_BREAKPOINT) setDrawerOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (crm.loading) return <div className="bcrm-root"><Loading label="Opening Gen Z Business Console…" /></div>;
  if (crm.error) return <div className="bcrm-root"><ErrorState message={crm.error} onRetry={crm.reloadBootstrap} /></div>;

  const navSections = (onNavigate) => grouped.map(({ group, items }) => (
    <div className="bcrm-nav-group" key={group}>
      <p className="bcrm-nav-group-label">{group}</p>
      <div className="bcrm-nav">
        {items.map((entry) => {
          const Icon = iconFor(entry.icon);
          return (
            <NavLink
              key={entry.path || 'dashboard'}
              to={crmPath(entry.path)}
              end={!entry.path}
              onClick={onNavigate}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{entry.label}</span>
            </NavLink>
          );
        })}
      </div>
    </div>
  ));

  const pendingLabel = crm.queued > 0
    ? `${crm.queued} pending sync${crm.queued === 1 ? '' : 's'}`
    : null;

  const connection = (
    <button
      type="button"
      className={`bcrm-connect ${crm.online ? '' : 'offline'}`}
      onClick={() => navigate(crmPath('offline-queue'))}
      title={pendingLabel ? `${pendingLabel} — open the offline queue` : 'Connection status'}
      aria-label={pendingLabel ? `${crm.online ? 'Online' : 'Offline'}, ${pendingLabel}. Open the offline queue.` : `${crm.online ? 'Online' : 'Offline'}. Open the offline queue.`}
    >
      <Icons.Wifi size={14} aria-hidden="true" />
      <span className="bcrm-connect-text">{crm.online ? 'Online' : 'Offline'}</span>
      {pendingLabel && <em>{pendingLabel}</em>}
    </button>
  );

  const currencySelect = (
    <div className="bcrm-toolbar-group">
      <label htmlFor="business-currency">Reporting currency</label>
      <select
        id="business-currency"
        aria-label="Reporting currency"
        value={crm.currency}
        onChange={(event) => crm.setCurrency(event.target.value)}
      >
        {CURRENCIES.map((currency) => (
          <option value={currency} key={currency}>{currency} — {CURRENCY_LABELS[currency]}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="bcrm-root">
      <div className="bcrm-shell">
        <aside className="bcrm-subnav" aria-label="Business CRM sections">
          <div className="bcrm-subnav-head">
            <strong>Business CRM</strong>
            <span>{crm.role || 'Team workspace'}</span>
          </div>
          <nav className="bcrm-nav-scroll">{navSections()}</nav>
          <a className="bcrm-subnav-back" href="/admin/dashboard">
            <Icons.ArrowLeft size={14} aria-hidden="true" />
            <span>Back to Admin Console</span>
          </a>
        </aside>

        <section className="bcrm-content">
          <header className="bcrm-toolbar">
            <div className="bcrm-toolbar-group bcrm-toolbar-lead">
              <button
                type="button"
                ref={menuButtonRef}
                className="bcrm-menu-btn"
                aria-expanded={drawerOpen}
                aria-controls="bcrm-drawer"
                aria-label="Open Business CRM navigation"
                onClick={() => setDrawerOpen(true)}
              >
                <Icons.Menu size={18} aria-hidden="true" />
              </button>
              <a className="bcrm-back-btn" href="/admin/dashboard" title="Back to Admin Console">
                <Icons.ArrowLeft size={15} aria-hidden="true" />
                <span>Admin Console</span>
              </a>
              <strong className="bcrm-toolbar-title">Business CRM</strong>
            </div>

            <div className="bcrm-toolbar-group bcrm-toolbar-trail">
              <button
                type="button"
                className="bcrm-icon-btn"
                onClick={() => navigate(crmPath('search'))}
                aria-label="Search the Business CRM"
                title="Search"
              >
                <Icons.Search size={16} aria-hidden="true" />
              </button>
              {currencySelect}
              {connection}
              {crm.queued > 0 && crm.online && (
                <Button
                  variant="ghost"
                  onClick={crm.runSync}
                  disabled={crm.syncing}
                  icon={crm.syncing ? Icons.LoaderCircle : Icons.RefreshCw}
                >
                  {crm.syncing ? 'Syncing' : 'Sync now'}
                </Button>
              )}
            </div>
          </header>

          <main className="bcrm-main"><Outlet /></main>

          {quickNav.length > 0 && (
            <nav className="bcrm-quicknav" aria-label="Business CRM quick navigation">
              {quickNav.map((entry) => {
                const Icon = iconFor(entry.icon);
                return (
                  <NavLink key={entry.path || 'dashboard'} to={crmPath(entry.path)} end={!entry.path} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                    <Icon size={18} aria-hidden="true" />
                    <span>{entry.label}</span>
                  </NavLink>
                );
              })}
              <button type="button" onClick={() => setDrawerOpen(true)} aria-label="More Business CRM sections">
                <Icons.MoreHorizontal size={18} aria-hidden="true" />
                <span>More</span>
              </button>
            </nav>
          )}
        </section>
      </div>

      {drawerOpen && (
        <div className="bcrm-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}>
          <div className="bcrm-drawer" id="bcrm-drawer" role="dialog" aria-modal="true" aria-label="Business CRM navigation" ref={drawerRef}>
            <header>
              <div>
                <strong>Business CRM</strong>
                <span>{crm.role || 'Team workspace'}</span>
              </div>
              <button type="button" onClick={closeDrawer} aria-label="Close navigation">
                <Icons.X size={18} aria-hidden="true" />
              </button>
            </header>
            <div className="bcrm-drawer-body">{navSections(closeDrawer)}</div>
            <footer>
              <a href="/admin/dashboard">
                <Icons.ArrowLeft size={14} aria-hidden="true" />
                <span>Back to Admin Console</span>
              </a>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
