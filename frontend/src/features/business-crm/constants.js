export const CURRENCIES = ['PKR', 'INR', 'NGN'];
export const CURRENCY_LABELS = { PKR: 'Pakistani Rupee', INR: 'Indian Rupee', NGN: 'Nigerian Naira' };
export const BASE = '/admin/business';
export const NAV = [
  ['Dashboard', '', 'LayoutDashboard', 'dashboard.view'],
  ['Sales', 'sales', 'ReceiptText', 'sales.view'],
  ['Clients', 'clients', 'Users', 'clients.view'],
  ['Vendors', 'vendors', 'Truck', 'vendors.view'],
  ['Products', 'products', 'Boxes', 'products.view'],
  ['Client Pending', 'client-pending', 'WalletCards', 'clients.view'],
  ['Vendor Dues', 'vendor-dues', 'Landmark', 'vendors.view'],
  ['Website Access', 'website-access', 'Link2', 'website-access.view'],
  ['Expiries', 'expiries', 'CalendarClock', 'expiries.view'],
  ['Expenses', 'expenses', 'BanknoteArrowDown', 'expenses.view'],
  ['Reports', 'reports', 'ChartNoAxesCombined', 'reports.view'],
  ['Cashbook', 'cashbook', 'BookOpenText', 'cashbook.view'],
  ['Tasks', 'tasks', 'ListChecks', 'tasks.view'],
  ['Search', 'search', 'Search', 'dashboard.view'],
  ['Offline Queue', 'offline-queue', 'CloudUpload', 'offline.sync'],
  ['Imports', 'imports', 'FileUp', 'imports.manage'],
  ['Access', 'access', 'ShieldCheck', 'access.manage'],
  ['Audit', 'audit', 'ScrollText', 'audit.view'],
  ['Settings', 'settings', 'Settings', 'settings.manage'],
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
