'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const money = require('../money');
const { asyncHandler, pageParams, sendCsv } = require('../http');
const { parseCsv, toCsv } = require('../csv');
const { validate } = require('../validation');
const { requirePermission, PERMISSIONS, fallbackRole, has } = require('../permissions');
const { httpError } = require('../services/salesService');
const User = require('../../../models/User');
const router = express.Router();
function actor(req) { return String(req.userId || req.user?._id); }
async function targetBusinessRole(userId) {
  const rows = await db.query('SELECT business_role FROM biz_crm_user_access WHERE user_id=:userId LIMIT 1', { userId });
  if (rows[0]?.business_role) return rows[0].business_role;
  const user = await User.findById(userId).select('role');
  return user ? fallbackRole(user.role) : null;
}
async function protectOwnerAccount(req, userId, requestedRole = null) {
  const currentRole = await targetBusinessRole(userId);
  const requesterIsOwner = req.businessAccess?.role === 'OWNER';
  if (!requesterIsOwner && (currentRole === 'OWNER' || requestedRole === 'OWNER')) {
    throw httpError('Only the Business CRM owner can manage an owner account', 403, 'OWNER_REQUIRED');
  }
  if (String(userId) === actor(req) && currentRole === 'OWNER' && requestedRole && requestedRole !== 'OWNER') {
    throw httpError('The active owner cannot demote their own account', 409, 'OWNER_SELF_DEMOTION');
  }
  return currentRole;
}
router.get('/settings', requirePermission('dashboard.view'), asyncHandler(async (req, res) => { const rows = await db.query('SELECT * FROM biz_crm_settings WHERE id=1'); res.json(rows[0]); }));
router.put('/settings', requirePermission('settings.manage'), validate('settings'), asyncHandler(async (req, res) => {
  const p = req.validated; const connection = await db.getPool().getConnection(); try { await connection.beginTransaction(); const [before] = await connection.execute('SELECT * FROM biz_crm_settings WHERE id=1 FOR UPDATE');
    await connection.execute(`UPDATE biz_crm_settings SET store_name=:storeName,store_email=:storeEmail,store_phone=:storePhone,store_address=:storeAddress,
      invoice_prefix=:invoicePrefix,default_currency=:defaultCurrency,whatsapp_country_code=:countryCode,invoice_terms=:invoiceTerms,logo_url=:logoUrl,
      include_credentials_in_invoice=:invoiceCredentials,include_credentials_in_messages=:messageCredentials,updated_by=:actor WHERE id=1`,
    { storeName: p.storeName, storeEmail: p.storeEmail || null, storePhone: p.storePhone || null, storeAddress: p.storeAddress || null, invoicePrefix: p.invoicePrefix,
      defaultCurrency: money.assertCurrency(p.defaultCurrency), countryCode: p.whatsappCountryCode, invoiceTerms: p.invoiceTerms || null, logoUrl: p.logoUrl || null,
      invoiceCredentials: p.includeCredentialsInInvoice ? 1 : 0, messageCredentials: p.includeCredentialsInMessages ? 1 : 0, actor: actor(req) });
    await audit.write(connection, req, 'settings.update', 'settings', '1', before[0], p); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const rows = await db.query('SELECT * FROM biz_crm_settings WHERE id=1'); res.json(rows[0]);
}));
router.get('/access', requirePermission('access.manage'), asyncHandler(async (req, res) => {
  const docs = await User.find({ role: { $in: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'] } }).select('email fullName role status lastLoginAt createdAt');
  const users = docs.map((doc) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
  const access = await db.query('SELECT * FROM biz_crm_user_access'); const overrides = await db.query('SELECT * FROM biz_crm_user_permissions');
  const accessMap = new Map(access.map((row) => [String(row.user_id), row]));
  const overrideMap = overrides.reduce((map, row) => { const key = String(row.user_id); if (!map[key]) map[key] = []; map[key].push({ permission: row.permission_key, effect: row.effect }); return map; }, {});
  const shaped = users.map((user) => ({ ...user, id: String(user._id || user.id), access: accessMap.get(String(user._id || user.id)) || null, overrides: overrideMap[String(user._id || user.id)] || [] }));
  // Team search is applied in JS, not SQL: the user list comes from the shared `users` model through
  // the Mongoose-style adapter, and the business role being searched lives in a separate CRM table
  // that is only joined here in memory. The list is bounded to three admin roles above.
  const search = String(req.query.search || req.query.q || '').trim().toLowerCase().slice(0, 160);
  const matched = search
    ? shaped.filter((user) => [user.fullName, user.email, user.role, user.status, user.access?.business_role]
      .some((field) => String(field || '').toLowerCase().includes(search)))
    : shaped;
  res.json({ permissions: PERMISSIONS, total: matched.length, users: matched });
}));
// Account provisioning and password resets are deliberately NOT exposed here. The Business CRM
// reads the existing `users` table (GET /access above) but must never write it: creating an
// account or bumping tokenVersion from inside the CRM would mutate live authentication state
// that the existing admin tooling owns. Accounts are still managed by the existing admin flows;
// the CRM only assigns business roles/permissions, which live in biz_crm_user_* tables.
router.post('/access/users', requirePermission('access.manage'), asyncHandler(async (req, res) => {
  throw httpError('Account creation is managed by the existing admin tooling, not the Business CRM', 405, 'CRM_USER_WRITE_DISABLED');
}));
router.put('/access/:userId', requirePermission('access.manage'), validate('access'), asyncHandler(async (req, res) => {
  const p = req.validated;
  await protectOwnerAccount(req, req.params.userId, p.businessRole);
  if (String(req.params.userId) === actor(req) && !p.active) throw httpError('You cannot disable your own Business CRM access', 409);
  const invalid = p.overrides.filter((x) => !PERMISSIONS.includes(x.permission)); if (invalid.length) throw httpError('Unknown permission override');
  const connection = await db.getPool().getConnection(); try { await connection.beginTransaction();
    await connection.execute(`INSERT INTO biz_crm_user_access (user_id,business_role,active,updated_by) VALUES (:id,:role,:active,:actor)
      ON DUPLICATE KEY UPDATE business_role=VALUES(business_role),active=VALUES(active),updated_by=VALUES(updated_by)`, { id: req.params.userId, role: p.businessRole, active: p.active ? 1 : 0, actor: actor(req) });
    await connection.execute('DELETE FROM biz_crm_user_permissions WHERE user_id=:id', { id: req.params.userId });
    for (const override of p.overrides) await connection.execute('INSERT INTO biz_crm_user_permissions (user_id,permission_key,effect,updated_by) VALUES (:id,:permission,:effect,:actor)', { id: req.params.userId, permission: override.permission, effect: override.effect, actor: actor(req) });
    await audit.write(connection, req, 'access.update', 'user', req.params.userId, null, p); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); } res.json({ userId: req.params.userId, ...p });
}));
// Disabled for the same reason as /access/users: a reset here would rewrite an existing User
// record and increment tokenVersion, silently invalidating a live admin session.
router.post('/access/:userId/reset-password', requirePermission('access.manage'), asyncHandler(async (req, res) => {
  throw httpError('Password resets are managed by the existing admin tooling, not the Business CRM', 405, 'CRM_USER_WRITE_DISABLED');
}));
router.get('/audit', requirePermission('audit.view'), asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query); const where = ['1=1']; const params = { limit: pageSize, offset };
  if (req.query.action) { where.push('action_key=:action'); params.action = req.query.action; } if (req.query.actor) { where.push('actor_user_id=:actorFilter'); params.actorFilter = req.query.actor; }
  const [rows, count] = await Promise.all([db.query(`SELECT * FROM biz_crm_audit_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`, params), db.query(`SELECT COUNT(*) total FROM biz_crm_audit_logs WHERE ${where.join(' AND ')}`, params)]); res.json({ rows, page, pageSize, total: Number(count[0]?.total || 0) });
}));
router.post('/imports/:kind', requirePermission('imports.manage'), express.text({ type: ['text/csv','text/plain','application/csv'], limit: '2mb' }), asyncHandler(async (req, res) => {
  const kind = req.params.kind; const config = {
    clients: { table: 'biz_crm_clients', columns: ['name','whatsapp','email','company','address','tax_id','notes','status'] },
    vendors: { table: 'biz_crm_vendors', columns: ['name','whatsapp','email','company','address','tax_id','notes','status'] },
    products: { table: 'biz_crm_products', columns: ['name','category','account_type','duration_label','default_sale_price','default_purchase_cost','currency_code','active','notes'] },
  }[kind]; if (!config) throw httpError('Unsupported import type', 404); const rows = parseCsv(req.body, { maxRows: 2000 }); const errors = []; let imported = 0; const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction(); for (const row of rows) { try { if (!String(row.name || '').trim()) throw new Error('name is required'); const id = crypto.randomUUID();
      if (kind === 'products') await connection.execute(`INSERT INTO biz_crm_products (id,name,category,account_type,duration_label,default_sale_price,default_purchase_cost,currency_code,active,notes,created_by)
        VALUES (:id,:name,:category,:accountType,:duration,:sale,:cost,:currency,:active,:notes,:actor)`, { id, name: row.name.trim(), category: row.category || 'Software', accountType: row.account_type || 'private', duration: row.duration_label || null, sale: money.normalize(row.default_sale_price || '0'), cost: money.normalize(row.default_purchase_cost || '0'), currency: money.assertCurrency(row.currency_code || 'PKR'), active: /^(1|true|yes|active)$/i.test(row.active || 'true') ? 1 : 0, notes: row.notes || null, actor: actor(req) });
      else await connection.execute(`INSERT INTO ${config.table} (id,name,whatsapp,email,company,address,tax_id,notes,status,created_by) VALUES (:id,:name,:whatsapp,:email,:company,:address,:taxId,:notes,:status,:actor)`, { id, name: row.name.trim(), whatsapp: row.whatsapp || null, email: row.email || null, company: row.company || null, address: row.address || null, taxId: row.tax_id || null, notes: row.notes || null, status: row.status || 'active', actor: actor(req) }); imported += 1;
    } catch (error) { errors.push({ row: row.__row, error: error.message }); } }
    const runId = crypto.randomUUID(); await connection.execute('INSERT INTO biz_crm_import_runs (id,entity_type,total_rows,imported_rows,rejected_rows,errors_json,created_by) VALUES (:id,:kind,:total,:imported,:rejected,:errors,:actor)', { id: runId, kind, total: rows.length, imported, rejected: errors.length, errors: JSON.stringify(errors), actor: actor(req) });
    await audit.write(connection, req, 'import.csv', kind, runId, null, { total: rows.length, imported, rejected: errors.length }); await connection.commit(); res.status(201).json({ runId, total: rows.length, imported, rejected: errors.length, errors });
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}));
router.get('/exports/sales.csv', requirePermission('exports.download'), asyncHandler(async (req, res) => {
  const rows = await db.query(`SELECT s.invoice_number,s.sale_date,s.currency_code,c.name client,v.name vendor,s.order_type,s.status,s.subtotal_sale,s.subtotal_cost,s.client_paid,
    (s.subtotal_sale-s.client_paid) client_pending,s.vendor_paid,(s.subtotal_cost-s.vendor_paid) vendor_due,GROUP_CONCAT(i.name ORDER BY i.sort_order SEPARATOR ' | ') products
    FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id LEFT JOIN biz_crm_vendors v ON v.id=s.vendor_id LEFT JOIN biz_crm_sale_items i ON i.sale_id=s.id
    WHERE s.deleted_at IS NULL GROUP BY s.id ORDER BY s.sale_date DESC`);
  const filtered = rows.map((row) => {
    const output = { ...row };
    if (!has(req, 'profit.view')) delete output.subtotal_cost;
    if (!has(req, 'vendors.view')) { delete output.vendor; delete output.vendor_paid; delete output.vendor_due; }
    return output;
  });
  sendCsv(res, 'business-crm-sales.csv', toCsv(filtered, Object.keys(filtered[0] || { invoice_number: '', sale_date: '', currency_code: '', client: '', subtotal_sale: '' })));
}));
router.get('/backup.json', requirePermission('backup.download'), asyncHandler(async (req, res) => {
  const tables = ['biz_crm_schema_migrations','biz_crm_settings','biz_crm_clients','biz_crm_vendors','biz_crm_products','biz_crm_invoice_sequences','biz_crm_sales','biz_crm_sale_items','biz_crm_payments','biz_crm_expenses','biz_crm_tasks','biz_crm_activities','biz_crm_reminders','biz_crm_saved_views','biz_crm_user_access','biz_crm_user_permissions','biz_crm_audit_logs','biz_crm_sync_operations','biz_crm_legacy_map','biz_crm_import_runs']; const data = {};
  for (const table of tables) data[table] = await db.query(`SELECT * FROM ${table}`); res.setHeader('Content-Disposition', `attachment; filename="business-crm-backup-${new Date().toISOString().slice(0,10)}.json"`); res.setHeader('Cache-Control','private, no-store'); res.json({ format: 'genz-business-crm-backup', version: '2.0.0', createdAt: new Date().toISOString(), encryptedCredentialFields: true, data });
}));
module.exports = router;
