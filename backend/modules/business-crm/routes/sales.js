'use strict';
const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../http');
const { validate } = require('../validation');
const { requirePermission, has } = require('../permissions');
const sales = require('../services/salesService');
const { buildInvoicePdf } = require('../invoicePdf');
const router = express.Router();

router.get('/', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  const result = await sales.listSales(req.query);
  res.json({ ...result, rows: result.rows.map((row) => sales.forRequest(req, row)) });
}));
router.post('/', requirePermission('sales.create'), validate('saleCreate'), asyncHandler(async (req, res) => {
  const result = await sales.createSale(req, req.validated);
  res.status(201).json(sales.forRequest(req, result));
}));
router.get('/:id', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  const include = req.query.credentials === '1' && has(req, 'credentials.view');
  res.json(sales.forRequest(req, await sales.getSale(req.params.id, include)));
}));
router.put('/:id', requirePermission('sales.edit'), validate('saleUpdate'), asyncHandler(async (req, res) => {
  res.json(sales.forRequest(req, await sales.updateSale(req, req.params.id, req.validated)));
}));
router.patch('/:id/status', requirePermission('sales.cancel'), asyncHandler(async (req, res) => {
  res.json(sales.forRequest(req, await sales.setSaleStatus(req, req.params.id, String(req.body.status || ''))));
}));
router.delete('/:id', requirePermission('sales.delete'), asyncHandler(async (req, res) => res.json(await sales.softDeleteSale(req, req.params.id))));
router.get('/:id/invoice.pdf', requirePermission('invoice.view'), asyncHandler(async (req, res) => {
  const settingsRows = await db.query('SELECT * FROM biz_crm_settings WHERE id=1');
  const settings = settingsRows[0] || {};
  const includeCredentials = req.query.credentials === '1' && Boolean(settings.include_credentials_in_invoice) && has(req, 'invoice.credentials') && has(req, 'credentials.view');
  const sale = await sales.getSale(req.params.id, includeCredentials);
  const pdf = buildInvoicePdf({ sale, settings, includeCredentials });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${sale.invoice_number.replace(/[^A-Za-z0-9_.-]/g, '_')}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
}));
module.exports = router;
