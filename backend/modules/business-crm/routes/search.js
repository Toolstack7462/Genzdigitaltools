'use strict';
const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../http');
const { requirePermission, has } = require('../permissions');
const router = express.Router();
router.get('/', requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const text = String(req.query.q || '').trim(); if (text.length < 2) return res.json({ query: text, results: [] }); const q = `%${text.slice(0, 160)}%`;
  const jobs = [];
  if (has(req, 'sales.view')) jobs.push(db.query(`SELECT 'sale' type,s.id,s.invoice_number title,CONCAT(c.name,' • ',GROUP_CONCAT(i.name SEPARATOR ', ')) subtitle,s.sale_date sort_date
    FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id LEFT JOIN biz_crm_sale_items i ON i.sale_id=s.id
    WHERE s.deleted_at IS NULL AND (s.invoice_number LIKE :q OR c.name LIKE :q OR i.name LIKE :q OR s.notes LIKE :q) GROUP BY s.id LIMIT 20`, { q }));
  if (has(req, 'clients.view')) jobs.push(db.query(`SELECT 'client' type,id,name title,CONCAT(COALESCE(whatsapp,''),' ',COALESCE(email,'')) subtitle,created_at sort_date FROM biz_crm_clients WHERE deleted_at IS NULL AND (name LIKE :q OR whatsapp LIKE :q OR email LIKE :q OR company LIKE :q) LIMIT 20`, { q }));
  if (has(req, 'vendors.view')) jobs.push(db.query(`SELECT 'vendor' type,id,name title,CONCAT(COALESCE(whatsapp,''),' ',COALESCE(email,'')) subtitle,created_at sort_date FROM biz_crm_vendors WHERE deleted_at IS NULL AND (name LIKE :q OR whatsapp LIKE :q OR email LIKE :q OR company LIKE :q) LIMIT 20`, { q }));
  if (has(req, 'tasks.view')) jobs.push(db.query(`SELECT 'task' type,id,title,CONCAT(status,' • ',priority) subtitle,created_at sort_date FROM biz_crm_tasks WHERE deleted_at IS NULL AND (title LIKE :q OR description LIKE :q) LIMIT 20`, { q }));
  const groups = await Promise.all(jobs); const results = groups.flat().sort((a, b) => String(b.sort_date).localeCompare(String(a.sort_date))).slice(0, 60); res.json({ query: text, results });
}));
module.exports = router;
