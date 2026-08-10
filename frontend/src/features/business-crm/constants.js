export const CURRENCIES = ['PKR', 'INR', 'NGN'];
export const CURRENCY_LABELS = { PKR: 'Pakistani Rupee', INR: 'Indian Rupee', NGN: 'Nigerian Naira' };
export const BASE = '/admin/business';

/**
 * The single source of truth for every in-CRM navigation target.
 *
 * The CRM renders a descendant <Routes> under App's `/admin/business/*` splat route. A RELATIVE
 * target (`to="sales"`, `navigate('sales/new')`, `<Navigate to="." />`) is resolved against the
 * active route branch, so navigating from an already-nested URL appended a segment instead of
 * moving to the sibling route — producing dead URLs like
 * `/admin/business/sales/sales/offline-queue/settings` that match nothing and render a blank
 * content region under a still-visible shell.
 *
 * Always route through this helper. It is idempotent, so passing an already-absolute CRM path back
 * through it can never duplicate the base.
 *
 *   crmPath()                       -> '/admin/business'
 *   crmPath('')                     -> '/admin/business'
 *   crmPath('sales')                -> '/admin/business/sales'
 *   crmPath('/sales')               -> '/admin/business/sales'
 *   crmPath('sales/123')            -> '/admin/business/sales/123'
 *   crmPath('/admin/business/sales')-> '/admin/business/sales'
 *   crmPath('sales?status=open')    -> '/admin/business/sales?status=open'
 *   crmPath('https://example.com')  -> '/admin/business'   (external targets refused)
 */
export function crmPath(target) {
  if (target === undefined || target === null) return BASE;
  const raw = String(target).trim();
  if (!raw || raw === '.' || raw === './') return BASE;

  // Refuse anything that could leave the app: absolute URLs, protocol-relative hosts and
  // pseudo-protocols. Callers linking to an external site must use a plain <a href> instead.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return BASE;

  // Split off a query/hash so path normalisation never mangles them.
  const marker = raw.search(/[?#]/);
  let pathPart = marker === -1 ? raw : raw.slice(0, marker);
  const suffix = marker === -1 ? '' : raw.slice(marker);

  // Idempotency: strip any number of leading base segments before re-adding exactly one.
  pathPart = pathPart.replace(/^\/+/, '/');
  const basePattern = new RegExp(`^(?:${BASE})+`, '');
  if (pathPart.startsWith(BASE)) pathPart = pathPart.replace(basePattern, '');

  // Collapse duplicate slashes and trim the edges, then rebuild from the base.
  const segments = pathPart.split('/').filter((segment) => segment && segment !== '.');
  return segments.length ? `${BASE}/${segments.join('/')}${suffix}` : `${BASE}${suffix}`;
}
export const NAV_GROUPS = ['Overview', 'Sales & Customers', 'Finance', 'Operations', 'Administration'];

/**
 * Sidebar navigation. Route PATHS are unchanged for backward compatibility — only labels and
 * grouping changed, so existing bookmarks and deep links keep working.
 *
 * Deliberately NOT listed here:
 *   - `search`        — promoted into the CRM toolbar; the /search route still exists.
 *   - `offline-queue` — surfaced through the connection status pill; the route still exists.
 * Both remain reachable, so no functionality was removed by the reorganisation.
 */
export const NAV = [
  { label: 'Dashboard', path: '', icon: 'LayoutDashboard', permission: 'dashboard.view', group: 'Overview' },
  { label: 'Website Access', path: 'website-access', icon: 'Link2', permission: 'website-access.view', group: 'Overview' },

  { label: 'Sales', path: 'sales', icon: 'ReceiptText', permission: 'sales.view', group: 'Sales & Customers' },
  { label: 'Billing Clients', path: 'clients', icon: 'Users', permission: 'clients.view', group: 'Sales & Customers' },
  { label: 'Pricing Catalogue', path: 'products', icon: 'Boxes', permission: 'products.view', group: 'Sales & Customers' },
  { label: 'Expiries', path: 'expiries', icon: 'CalendarClock', permission: 'expiries.view', group: 'Sales & Customers' },

  { label: 'Vendors', path: 'vendors', icon: 'Truck', permission: 'vendors.view', group: 'Finance' },
  { label: 'Client Pending', path: 'client-pending', icon: 'WalletCards', permission: 'clients.view', group: 'Finance' },
  { label: 'Vendor Dues', path: 'vendor-dues', icon: 'Landmark', permission: 'vendors.view', group: 'Finance' },
  { label: 'Expenses', path: 'expenses', icon: 'BanknoteArrowDown', permission: 'expenses.view', group: 'Finance' },
  { label: 'Cashbook', path: 'cashbook', icon: 'BookOpenText', permission: 'cashbook.view', group: 'Finance' },
  { label: 'Reports', path: 'reports', icon: 'ChartNoAxesCombined', permission: 'reports.view', group: 'Finance' },

  { label: 'Tasks', path: 'tasks', icon: 'ListChecks', permission: 'tasks.view', group: 'Operations' },

  { label: 'Imports', path: 'imports', icon: 'FileUp', permission: 'imports.manage', group: 'Administration' },
  { label: 'Team & Permissions', path: 'access', icon: 'ShieldCheck', permission: 'access.manage', group: 'Administration' },
  { label: 'Audit', path: 'audit', icon: 'ScrollText', permission: 'audit.view', group: 'Administration' },
  { label: 'Settings', path: 'settings', icon: 'Settings', permission: 'settings.manage', group: 'Administration' },
];

/** Compact mobile quick-nav; "More" opens the grouped drawer rather than listing every route. */
export const MOBILE_QUICK_NAV = [
  { label: 'Dashboard', path: '', icon: 'LayoutDashboard', permission: 'dashboard.view' },
  { label: 'Sales', path: 'sales', icon: 'ReceiptText', permission: 'sales.view' },
  { label: 'Access', path: 'website-access', icon: 'Link2', permission: 'website-access.view' },
];
export function formatMoney(value, currency = 'PKR') {
  const number = Number(value || 0);
  try { return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number); }
  catch (_) { return `${currency} ${number.toFixed(2)}`; }
}
export function formatDate(value, withTime = false) {
  if (!value) return '—'; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-GB', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
}
export function today() { return new Date().toISOString().slice(0, 10); }
export function monthRange() { const d = new Date(); return { from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0,10), to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 0)).toISOString().slice(0,10) }; }
