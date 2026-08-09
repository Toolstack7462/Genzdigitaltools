'use strict';
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const contactService = require('../services/contactService');
const money = require('../money');
const { asyncHandler, pageParams } = require('../http');
const { validate } = require('../validation');
const { requirePermission, has } = require('../permissions');
const { httpError } = require('../services/salesService');
const router = express.Router();

const CONFIG = {
  clients: { table: 'biz_crm_clients', singular: 'client', create: 'clients.create', view: 'clients.view', edit: 'clients.edit', delete: 'clients.delete', schemaCreate: 'clientCreate', schemaUpdate: 'clientUpdate', saleKey: 'client_id', total: 'subtotal_sale', paid: 'client_paid' },
  vendors: { table: 'biz_crm_vendors', singular: 'vendor', create: 'vendors.create', view: 'vendors.view', edit: 'vendors.edit', delete: 'vendors.delete', schemaCreate: 'vendorCreate', schemaUpdate: 'vendorUpdate', saleKey: 'vendor_id', total: 'subtotal_cost', paid: 'vendor_paid' },
};
function cfg(req) { const value = CONFIG[req.params.kind]; if (!value) throw httpError('Unknown contact module', 404); return value; }
function actor(req) { return String(req.userId || req.user?._id); }
function payloadParams(value) {
  return { name: value.name, whatsapp: value.whatsapp || null, email: value.email || null, company: value.company || null,
    address: value.address || null, taxId: value.taxId || null, notes: value.notes || null, status: value.status || 'active' };
}
router.use('/:kind', (req, res, next) => { try { req.contactConfig = cfg(req); next(); } catch (error) { next(error); } });
router.get('/:kind', (req, res, next) => requirePermission(req.contactConfig.view)(req, res, next), asyncHandler(async (req, res) => {
  const c = req.contactConfig; const { page, pageSize, offset } = pageParams(req.query);
  const where = ['deleted_at IS NULL']; const params = { limit: pageSize, offset };
  if (req.query.status) { where.push('status=:status'); params.status = req.query.status; }
  if (req.query.q) { where.push('(name LIKE :q OR whatsapp LIKE :q OR email LIKE :q OR company LIKE :q)'); params.q = `%${String(req.query.q).slice(0, 160)}%`; }
  const [rows, counts] = await Promise.all([
    db.query(`SELECT * FROM ${c.table} WHERE ${where.join(' AND ')} ORDER BY name LIMIT :limit OFFSET :offset`, params),
    db.query(`SELECT COUNT(*) total FROM ${c.table} WHERE ${where.join(' AND ')}`, params),
  ]);
  res.json({ rows: rows.map(contactService.forResponse), page, pageSize, total: Number(counts[0]?.total || 0) });
}));
router.post('/:kind', (req, res, next) => requirePermission(req.contactConfig.create)(req, res, next), (req, res, next) => validate(req.contactConfig.schemaCreate)(req, res, next), asyncHandler(async (req, res) => {
  res.status(201).json(await contactService.createContact(req, req.params.kind, req.validated));
}));
router.get('/:kind/:id', (req, res, next) => requirePermission(req.contactConfig.view)(req, res, next), asyncHandler(async (req, res) => {
  const c = req.contactConfig;
  const rows = await db.query(`SELECT * FROM ${c.table} WHERE id=:id AND deleted_at IS NULL LIMIT 1`, { id: req.params.id });
  if (!rows.length) throw httpError(`${c.singular} not found`, 404);
  const [sales, tasks, activities, totals] = await Promise.all([
    db.query(`SELECT id,invoice_number,sale_date,currency_code,subtotal_sale,subtotal_cost,client_paid,vendor_paid,status FROM biz_crm_sales WHERE ${c.saleKey}=:id AND deleted_at IS NULL ORDER BY sale_date DESC`, { id: req.params.id }),
    db.query(`SELECT * FROM biz_crm_tasks WHERE ${c.singular}_id=:id AND deleted_at IS NULL ORDER BY due_at IS NULL,due_at`, { id: req.params.id }),
    db.query(`SELECT * FROM biz_crm_activities WHERE entity_type=:type AND entity_id=:id ORDER BY created_at DESC LIMIT 100`, { type: c.singular, id: req.params.id }),
    db.query(`SELECT currency_code,SUM(${c.total}) total_amount,SUM(${c.paid}) paid_amount,SUM(${c.total}-${c.paid}) pending_amount,COUNT(*) sale_count
      FROM biz_crm_sales WHERE ${c.saleKey}=:id AND deleted_at IS NULL AND status<>'cancelled' GROUP BY currency_code`, { id: req.params.id }),
  ]);
  const saleRows = sales.map((sale) => {
    const base = { id: sale.id, invoice_number: sale.invoice_number, sale_date: sale.sale_date, currency_code: sale.currency_code, status: sale.status };
    if (c.singular === 'client') {
      Object.assign(base, { subtotal_sale: money.normalize(sale.subtotal_sale), client_paid: money.normalize(sale.client_paid) });
      if (has(req, 'profit.view')) Object.assign(base, { subtotal_cost: money.normalize(sale.subtotal_cost), gross_profit: money.subtract(sale.subtotal_sale, sale.subtotal_cost) });
    } else {
      Object.assign(base, { subtotal_cost: money.normalize(sale.subtotal_cost), vendor_paid: money.normalize(sale.vendor_paid) });
      if (has(req, 'profit.view')) Object.assign(base, { subtotal_sale: money.normalize(sale.subtotal_sale), gross_profit: money.subtract(sale.subtotal_sale, sale.subtotal_cost) });
    }
    return base;
  });
  const taskRows = has(req, 'vendors.view') ? tasks : tasks.map((task) => { const output = { ...task }; delete output.vendor_id; return output; });
  res.json({ ...contactService.forResponse(rows[0]), sales: saleRows, tasks: taskRows, activities, totals: totals.map((x) => ({ ...x, total_amount: money.normalize(x.total_amount), paid_amount: money.normalize(x.paid_amount), pending_amount: money.normalize(x.pending_amount) })) });
}));
router.put('/:kind/:id', (req, res, next) => requirePermission(req.contactConfig.edit)(req, res, next), (req, res, next) => validate(req.contactConfig.schemaUpdate)(req, res, next), asyncHandler(async (req, res) => {
  const c = req.contactConfig; const p = payloadParams(req.validated); const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction();
    const [beforeRows] = await connection.execute(`SELECT * FROM ${c.table} WHERE id=:id AND deleted_at IS NULL FOR UPDATE`, { id: req.params.id });
    if (!beforeRows.length) throw httpError(`${c.singular} not found`, 404);
    if (Number(beforeRows[0].version) !== Number(req.validated.version)) throw httpError('Version conflict', 409, 'VERSION_CONFLICT');
    await connection.execute(`UPDATE ${c.table} SET name=:name,whatsapp=:whatsapp,email=:email,company=:company,address=:address,tax_id=:taxId,
      notes=:notes,status=:status,updated_by=:actor,version=version+1 WHERE id=:id AND version=:version`, { ...p, actor: actor(req), id: req.params.id, version: req.validated.version });
    await audit.write(connection, req, `${c.singular}.update`, c.singular, req.params.id, beforeRows[0], p); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const rows = await db.query(`SELECT * FROM ${c.table} WHERE id=:id`, { id: req.params.id }); res.json(contactService.forResponse(rows[0]));
}));
router.delete('/:kind/:id', (req, res, next) => requirePermission(req.contactConfig.delete)(req, res, next), asyncHandler(async (req, res) => {
  const c = req.contactConfig; const linked = await db.query(`SELECT COUNT(*) total FROM biz_crm_sales WHERE ${c.saleKey}=:id AND deleted_at IS NULL`, { id: req.params.id });
  if (Number(linked[0]?.total || 0) > 0) throw httpError('Linked financial records prevent deletion; mark this contact inactive instead', 409, 'CONTACT_IN_USE');
  const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction(); await connection.execute(`UPDATE ${c.table} SET deleted_at=NOW(),updated_by=:actor,version=version+1 WHERE id=:id`, { actor: actor(req), id: req.params.id });
    await audit.write(connection, req, `${c.singular}.delete`, c.singular, req.params.id, null, { deleted: true }); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  res.json({ id: req.params.id, deleted: true });
}));
module.exports = router;
