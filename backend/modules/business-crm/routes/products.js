'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const money = require('../money');
const { asyncHandler, pageParams } = require('../http');
const { validate } = require('../validation');
const { requirePermission, has } = require('../permissions');
const { httpError } = require('../services/salesService');
const router = express.Router();
function actor(req) { return String(req.userId || req.user?._id); }
function forRequest(req, row) {
  const product = { ...row, default_sale_price: money.normalize(row.default_sale_price) };
  if (has(req, 'profit.view') || has(req, 'products.manage')) product.default_purchase_cost = money.normalize(row.default_purchase_cost);
  else delete product.default_purchase_cost;
  return product;
}
function values(p) { return { name: p.name, category: p.category, accountType: p.accountType, durationLabel: p.durationLabel || null,
  sale: money.normalize(p.defaultSalePrice), cost: money.normalize(p.defaultPurchaseCost), currency: money.assertCurrency(p.currencyCode), active: p.active ? 1 : 0, notes: p.notes || null }; }
router.get('/', requirePermission('products.view'), asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query); const where = ['deleted_at IS NULL']; const params = { limit: pageSize, offset };
  if (req.query.currency) { where.push('currency_code=:currency'); params.currency = money.assertCurrency(req.query.currency); }
  if (req.query.active !== undefined) { where.push('active=:active'); params.active = String(req.query.active) === 'false' ? 0 : 1; }
  if (req.query.q) { where.push('(name LIKE :q OR category LIKE :q)'); params.q = `%${String(req.query.q).slice(0, 160)}%`; }
  const [rows, counts] = await Promise.all([db.query(`SELECT * FROM biz_crm_products WHERE ${where.join(' AND ')} ORDER BY name LIMIT :limit OFFSET :offset`, params), db.query(`SELECT COUNT(*) total FROM biz_crm_products WHERE ${where.join(' AND ')}`, params)]);
  res.json({ rows: rows.map((row) => forRequest(req, row)), page, pageSize, total: Number(counts[0]?.total || 0) });
}));
router.post('/', requirePermission('products.manage'), validate('productCreate'), asyncHandler(async (req, res) => {
  const id = crypto.randomUUID(); const p = values(req.validated); const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction(); await connection.execute(`INSERT INTO biz_crm_products
    (id,name,category,account_type,duration_label,default_sale_price,default_purchase_cost,currency_code,active,notes,created_by)
    VALUES (:id,:name,:category,:accountType,:durationLabel,:sale,:cost,:currency,:active,:notes,:actor)`, { id, ...p, actor: actor(req) });
    await audit.write(connection, req, 'product.create', 'product', id, null, p); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const rows = await db.query('SELECT * FROM biz_crm_products WHERE id=:id', { id }); res.status(201).json(forRequest(req, rows[0]));
}));
router.put('/:id', requirePermission('products.manage'), validate('productUpdate'), asyncHandler(async (req, res) => {
  const p = values(req.validated); const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction(); const [beforeRows] = await connection.execute('SELECT * FROM biz_crm_products WHERE id=:id AND deleted_at IS NULL FOR UPDATE', { id: req.params.id });
    if (!beforeRows.length) throw httpError('Product not found', 404); if (Number(beforeRows[0].version) !== Number(req.validated.version)) throw httpError('Version conflict', 409, 'VERSION_CONFLICT');
    await connection.execute(`UPDATE biz_crm_products SET name=:name,category=:category,account_type=:accountType,duration_label=:durationLabel,
      default_sale_price=:sale,default_purchase_cost=:cost,currency_code=:currency,active=:active,notes=:notes,updated_by=:actor,version=version+1
      WHERE id=:id AND version=:version`, { ...p, actor: actor(req), id: req.params.id, version: req.validated.version });
    await audit.write(connection, req, 'product.update', 'product', req.params.id, beforeRows[0], p); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const rows = await db.query('SELECT * FROM biz_crm_products WHERE id=:id', { id: req.params.id }); res.json(forRequest(req, rows[0]));
}));
router.delete('/:id', requirePermission('products.manage'), asyncHandler(async (req, res) => {
  await db.query('UPDATE biz_crm_products SET deleted_at=NOW(),active=0,updated_by=:actor,version=version+1 WHERE id=:id', { actor: actor(req), id: req.params.id }); res.json({ id: req.params.id, deleted: true });
}));
module.exports = router;
