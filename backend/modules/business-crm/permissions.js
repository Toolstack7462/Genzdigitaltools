'use strict';

const db = require('./db');

const PERMISSIONS = Object.freeze([
  'dashboard.view', 'sales.view', 'sales.create', 'sales.edit', 'sales.cancel', 'sales.delete',
  'credentials.view', 'credentials.manage', 'invoice.view', 'invoice.credentials',
  'clients.view', 'clients.create', 'clients.edit', 'clients.delete',
  'vendors.view', 'vendors.create', 'vendors.edit', 'vendors.delete',
  'products.view', 'products.manage',
  'payments.client.record', 'payments.vendor.record', 'payments.reverse',
  'reminders.prepare', 'expiries.view',
  'expenses.view', 'expenses.manage', 'reports.view', 'profit.view', 'cashbook.view',
  'tasks.view', 'tasks.manage', 'activities.view', 'activities.manage', 'imports.manage', 'exports.download',
  'settings.manage', 'access.manage', 'audit.view', 'backup.download', 'offline.sync',
  // Website access → CRM reconciliation. `view` lists the mirrored access records, `reconcile`
  // triggers the pull sweep, `financial-link` attaches a sale or marks a record non-billable.
  // Creating the sale itself still requires sales.create, and cost/profit still require profit.view.
  'website-access.view', 'website-access.reconcile', 'website-access.financial-link',
]);

const ROLE_PERMISSIONS = Object.freeze({
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set(PERMISSIONS),
  MANAGER: new Set(PERMISSIONS.filter((permission) => ![
    'access.manage', 'backup.download', 'settings.manage', 'sales.delete', 'credentials.manage',
  ].includes(permission))),
  STAFF: new Set([
    'dashboard.view', 'sales.view', 'sales.create', 'sales.edit', 'invoice.view', 'credentials.manage',
    'clients.view', 'clients.create', 'clients.edit', 'products.view',
    'payments.client.record', 'reminders.prepare', 'expiries.view',
    'tasks.view', 'tasks.manage', 'activities.view', 'activities.manage', 'offline.sync',
    // Staff can see what needs financial details but cannot trigger a sweep or attach money to it
    // unless an explicit allow-override is granted.
    'website-access.view',
  ]),
  VIEWER: new Set([
    'dashboard.view', 'sales.view', 'invoice.view', 'clients.view', 'vendors.view',
    'products.view', 'expiries.view', 'expenses.view', 'reports.view', 'cashbook.view', 'tasks.view', 'activities.view',
    'website-access.view',
  ]),
});

function fallbackRole(authRole) {
  if (authRole === 'SUPER_ADMIN') return 'OWNER';
  if (authRole === 'ADMIN') return 'ADMIN';
  return 'STAFF';
}

async function resolveAccess(user) {
  const userId = String(user._id || user.id);
  const rows = await db.query('SELECT business_role, active FROM biz_crm_user_access WHERE user_id=:userId LIMIT 1', { userId });
  const role = rows[0]?.active === 0 ? 'DISABLED' : (rows[0]?.business_role || fallbackRole(user.role));
  if (role === 'DISABLED') return { role, permissions: [] };
  const base = new Set(ROLE_PERMISSIONS[role] || []);
  const overrides = await db.query('SELECT permission_key, effect FROM biz_crm_user_permissions WHERE user_id=:userId', { userId });
  for (const override of overrides) {
    if (!PERMISSIONS.includes(override.permission_key)) continue;
    if (override.effect === 'allow') base.add(override.permission_key);
    if (override.effect === 'deny') base.delete(override.permission_key);
  }
  return { role, permissions: [...base].sort() };
}

function requirePermission(permission) {
  if (!PERMISSIONS.includes(permission)) throw new Error(`Unknown permission: ${permission}`);
  return (req, res, next) => {
    if (!req.businessAccess?.permissions?.includes(permission)) {
      return res.status(403).json({ error: 'Insufficient Business CRM permission', code: 'BUSINESS_PERMISSION_DENIED', permission });
    }
    return next();
  };
}
function has(req, permission) { return Boolean(req.businessAccess?.permissions?.includes(permission)); }
module.exports = { PERMISSIONS, ROLE_PERMISSIONS, fallbackRole, resolveAccess, requirePermission, has };
