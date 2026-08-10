'use strict';
const express = require('express');
const db = require('../db');
const { asyncHandler, safeLike } = require('../http');
const { requirePermission, has } = require('../permissions');
const router = express.Router();
function actor(req) { return String(req.userId || req.user?._id); }
router.get('/', requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const text = String(req.query.q || '').trim();
  if (text.length < 2) return res.json({ query: text, results: [], truncated: false });
  // safeLike escapes backslash, percent and underscore. The previous inline interpolation did not,
  // so a single "%" matched every row in every module at once.
  const q = safeLike(text);
  const wanted = String(req.query.types || '').split(',').map((value) => value.trim()).filter(Boolean);
  const jobs = [];
  // Each source is added only when the caller holds the permission that guards the module's own
  // list endpoint, so global search can never become a way around a module the operator cannot open.
  const add = (type, permission, sql, params = {}) => {
    if (!has(req, permission)) return;
    if (wanted.length && !wanted.includes(type)) return;
    jobs.push(db.query(sql, { q, ...params }));
  };

  add('sale', 'sales.view', `SELECT 'sale' type,s.id,s.invoice_number title,CONCAT(c.name,' • ',COALESCE(GROUP_CONCAT(i.name SEPARATOR ', '),'')) subtitle,s.sale_date sort_date
    FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id LEFT JOIN biz_crm_sale_items i ON i.sale_id=s.id
    WHERE s.deleted_at IS NULL AND (s.invoice_number LIKE :q OR c.name LIKE :q OR i.name LIKE :q OR s.notes LIKE :q) GROUP BY s.id LIMIT 20`);

  add('client', 'clients.view', `SELECT 'client' type,id,name title,CONCAT(COALESCE(whatsapp,''),' ',COALESCE(email,'')) subtitle,created_at sort_date
    FROM biz_crm_clients WHERE deleted_at IS NULL AND (name LIKE :q OR whatsapp LIKE :q OR email LIKE :q OR company LIKE :q) LIMIT 20`);

  add('vendor', 'vendors.view', `SELECT 'vendor' type,id,name title,CONCAT(COALESCE(whatsapp,''),' ',COALESCE(email,'')) subtitle,created_at sort_date
    FROM biz_crm_vendors WHERE deleted_at IS NULL AND (name LIKE :q OR whatsapp LIKE :q OR email LIKE :q OR company LIKE :q) LIMIT 20`);

  add('product', 'products.view', `SELECT 'product' type,id,name title,CONCAT(category,' • ',currency_code) subtitle,created_at sort_date
    FROM biz_crm_products WHERE deleted_at IS NULL AND (name LIKE :q OR category LIKE :q OR COALESCE(duration_label,'') LIKE :q) LIMIT 20`);

  // Tasks repeat the STAFF scope from routes/operations.js. Without it a STAFF operator could read
  // the title of a task assigned to someone else through global search, which the tasks list itself
  // refuses to show them.
  const staffScoped = req.businessAccess?.role === 'STAFF';
  add('task', 'tasks.view', `SELECT 'task' type,id,title,CONCAT(status,' • ',priority) subtitle,created_at sort_date
    FROM biz_crm_tasks WHERE deleted_at IS NULL AND (title LIKE :q OR description LIKE :q)
    ${staffScoped ? 'AND (assigned_user_id=:scopeActor OR created_by=:scopeActor)' : ''} LIMIT 20`,
  staffScoped ? { scopeActor: actor(req) } : {});

  add('access', 'website-access.view', `SELECT 'access' type,id,COALESCE(tool_name,external_key) title,
    CONCAT(COALESCE(client_name,'Unmatched client'),' • ',source_type,' • ',access_status) subtitle,COALESCE(expiry_date,first_seen_at) sort_date
    FROM biz_crm_access_links WHERE (client_name LIKE :q OR client_email LIKE :q OR client_phone LIKE :q
      OR tool_name LIKE :q OR source_type LIKE :q OR external_key LIKE :q) LIMIT 20`);

  add('expiry', 'expiries.view', `SELECT 'expiry' type,i.id,i.name title,s.id sale_id,
    CONCAT(c.name,' • ',s.invoice_number,' • expires ',DATE_FORMAT(i.expiry_date,'%Y-%m-%d')) subtitle,i.expiry_date sort_date
    FROM biz_crm_sale_items i JOIN biz_crm_sales s ON s.id=i.sale_id JOIN biz_crm_clients c ON c.id=s.client_id
    WHERE s.deleted_at IS NULL AND s.status<>'cancelled' AND i.expiry_date IS NOT NULL
      AND (i.name LIKE :q OR c.name LIKE :q OR s.invoice_number LIKE :q) LIMIT 20`);

  // Payment references are split by party so the vendor leg stays behind vendors.view: a payment row
  // names the counterparty, so returning vendor payments to a client-only operator would leak the
  // vendor list. Client receipts require clients.view for the same reason.
  const paymentParties = [];
  if (has(req, 'clients.view')) paymentParties.push("'client'");
  if (has(req, 'vendors.view')) paymentParties.push("'vendor'");
  if (paymentParties.length && (!wanted.length || wanted.includes('payment'))) {
    jobs.push(db.query(`SELECT 'payment' type,p.id,s.id sale_id,CONCAT(s.invoice_number,' • ',p.currency_code,' ',p.amount) title,
      CONCAT(CASE WHEN p.party_type='client' THEN c.name ELSE COALESCE(v.name,'Vendor') END,' • ',COALESCE(p.method,'—'),
        CASE WHEN p.reference IS NULL OR p.reference='' THEN '' ELSE CONCAT(' • ref ',p.reference) END) subtitle,p.payment_date sort_date
      FROM biz_crm_payments p JOIN biz_crm_sales s ON s.id=p.sale_id JOIN biz_crm_clients c ON c.id=s.client_id
      LEFT JOIN biz_crm_vendors v ON v.id=s.vendor_id
      WHERE p.party_type IN (${paymentParties.join(',')}) AND (p.reference LIKE :q OR p.method LIKE :q OR p.notes LIKE :q
        OR s.invoice_number LIKE :q OR c.name LIKE :q) LIMIT 20`, { q }));
  }

  const groups = await Promise.all(jobs);
  const all = groups.flat().sort((a, b) => String(b.sort_date || '').localeCompare(String(a.sort_date || '')));
  const results = all.slice(0, 60);
  // Reported so the UI can say the list was cut rather than implying these are all the matches.
  res.json({ query: text, results, total: all.length, truncated: all.length > results.length });
}));
module.exports = router;
