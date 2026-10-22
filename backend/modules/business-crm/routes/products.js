'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const money = require('../money');
const { asyncHandler, pageParams, safeLike } = require('../http');
const { validate } = require('../validation');
const { requirePermission, has } = require('../permissions');
const { httpError } = require('../services/salesService');
const catalogue = require('../services/productCatalogueService');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Same shape as the access-link reconcile limiter: a bounded number of authorised sweeps per
// minute per actor, so repeated Products-page opens cannot turn into a write loop.
const catalogueLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.userId || req.ip),
  message: { error: 'Catalogue reconciliation is rate limited; try again shortly', code: 'CATALOGUE_RATE_LIMITED' },
});
function actor(req) { return String(req.userId || req.user?._id); }
function forRequest(req, row) {
  const product = { ...row, default_sale_price: money.normalize(row.default_sale_price) };
  if (has(req, 'profit.view') || has(req, 'products.manage')) product.default_purchase_cost = money.normalize(row.default_purchase_cost);
  else delete product.default_purchase_cost;
  // Source status, when this product came from the website. `source` is absent for manual
  // products, which is what lets the UI tell the two apart without guessing from the name.
  //
  // WHILE NEEDS_SETUP, THE COMMERCIAL FIELDS ARE PLACEHOLDERS, NOT DATA. They stay in the row
  // because the columns are NOT NULL, but they are blanked here so no caller - the catalogue list,
  // the sale picker, the offline cache or a future report - can read 0.00 as a confirmed price,
  // 'private' as a confirmed account type or 'PKR' as a confirmed currency.
  if (row.source_namespace) {
    const needsSetup = row.readiness !== 'READY';
    product.source = {
      namespace: row.source_namespace,
      readiness: row.readiness,
      availability: row.source_availability,
      ignored: !!row.ignored_at,
      nameOverridden: !!Number(row.name_overridden || 0),
      lastSeenAt: row.last_seen_at || null,
      sellable: !needsSetup && row.source_availability === 'AVAILABLE' && !row.ignored_at,
    };
    if (needsSetup) {
      product.commercialDetailsConfirmed = false;
      product.default_sale_price = null;
      if ('default_purchase_cost' in product) product.default_purchase_cost = null;
      product.currency_code = null;
      product.account_type = null;
      product.duration_label = null;
    } else {
      product.commercialDetailsConfirmed = true;
    }
  }
  delete product.source_namespace; delete product.readiness; delete product.source_availability;
  delete product.ignored_at; delete product.name_overridden; delete product.last_seen_at;
  return product;
}
function values(p) { return { name: p.name, category: p.category, accountType: p.accountType, durationLabel: p.durationLabel || null,
  sale: money.normalize(p.defaultSalePrice), cost: money.normalize(p.defaultPurchaseCost), currency: money.assertCurrency(p.currencyCode), active: p.active ? 1 : 0, notes: p.notes || null }; }
router.get('/', requirePermission('products.view'), asyncHandler(async (req, res) => {
  // Clauses are written against the `p` alias directly. The previous version of this handler had
  // no join, so its unqualified column names are now ambiguous; rewriting them with a regex would
  // be a silent breakage waiting for the next filter to be added.
  const { page, pageSize, offset } = pageParams(req.query);
  const where = ['p.deleted_at IS NULL'];
  const params = { limit: pageSize, offset };
  if (req.query.currency) { where.push('p.currency_code=:currency'); params.currency = money.assertCurrency(req.query.currency); }
  if (req.query.active !== undefined) { where.push('p.active=:active'); params.active = String(req.query.active) === 'false' ? 0 : 1; }
  if (req.query.q) { where.push("(p.name LIKE :q OR p.category LIKE :q OR COALESCE(p.duration_label,'') LIKE :q)"); params.q = safeLike(req.query.q); }
  // Optional source filters for the catalogue UI. Absent -> unchanged behaviour.
  if (req.query.readiness === 'NEEDS_SETUP' || req.query.readiness === 'READY') {
    where.push('ps.readiness=:readiness'); params.readiness = req.query.readiness;
  }
  if (req.query.linked === 'true') where.push('ps.id IS NOT NULL');
  if (req.query.linked === 'false') where.push('ps.id IS NULL');
  // LEFT JOIN: a manual product has no mapping row and must come back exactly as before.
  const FROM = `FROM biz_crm_products p LEFT JOIN biz_crm_product_sources ps ON ps.product_id = p.id WHERE ${where.join(' AND ')}`;
  const sourceCols = 'ps.source_namespace, ps.readiness, ps.source_availability, ps.ignored_at, ps.name_overridden, ps.last_seen_at';
  const [rows, counts] = await Promise.all([
    db.query(`SELECT p.*, ${sourceCols} ${FROM} ORDER BY p.name LIMIT :limit OFFSET :offset`, params),
    db.query(`SELECT COUNT(*) total ${FROM}`, params),
  ]);
  res.json({ rows: rows.map((row) => forRequest(req, row)), page, pageSize, total: Number(counts[0]?.total || 0) });
}));
// Read-only. A products.view holder opening the catalogue causes NO write of any kind.
router.get('/catalogue/status', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json(await catalogue.status());
}));

// Read-only preview. Shows discovered sources, existing links, proposed entries, possible manual
// matches, ignored entries, missing candidates and the still-unresolved source families.
router.post('/catalogue/dry-run', requirePermission('products.manage'), catalogueLimiter, asyncHandler(async (req, res) => {
  res.json(await catalogue.dryRun());
}));

// The only endpoint that creates imported products. POST, products.manage, rate limited, and
// bounded by a cross-worker freshness check unless the operator explicitly forces a sweep.
router.post('/catalogue/reconcile', requirePermission('products.manage'), catalogueLimiter, asyncHandler(async (req, res) => {
  const result = await catalogue.reconcile(req, { force: req.body && req.body.force === true });
  res.json(result);
}));

// Explicit commercial confirmation. Deliberately NOT part of an ordinary product save.
router.post('/:id/catalogue/confirm-ready', requirePermission('products.manage'), validate('catalogueConfirmReady'), asyncHandler(async (req, res) => {
  res.json(await catalogue.confirmReady(req, req.params.id, req.validated || req.body || {}));
}));

// Resolve a held-back ambiguous source: "this existing product IS that source".
router.post('/:id/catalogue/link', requirePermission('products.manage'), validate('catalogueLink'), asyncHandler(async (req, res) => {
  res.json(await catalogue.linkExisting(req, req.params.id, req.validated || req.body || {}));
}));

// Resolve it the other way: the resemblance is coincidental, create a separate product.
router.post('/catalogue/approve-create', requirePermission('products.manage'), validate('catalogueLink'), asyncHandler(async (req, res) => {
  res.json(await catalogue.approveCreate(req, req.validated || req.body || {}));
}));

// Keep a discovered source out of the catalogue. The decision survives every later sweep.
router.post('/:id/catalogue/ignore', requirePermission('products.manage'), validate('catalogueIgnore'), asyncHandler(async (req, res) => {
  const body = req.validated || req.body || {};
  res.json(await catalogue.setIgnored(req, req.params.id, body.ignored !== false));
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
