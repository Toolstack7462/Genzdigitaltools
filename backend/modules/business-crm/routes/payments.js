'use strict';
const express = require('express');
const { asyncHandler } = require('../http');
const { validate } = require('../validation');
const { requirePermission, has } = require('../permissions');
const payments = require('../services/paymentService');
const sales = require('../services/salesService');
const router = express.Router();
router.get('/', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  let rows = await payments.listPayments(req.query);
  if (!has(req, 'vendors.view')) rows = rows.filter((row) => row.party_type !== 'vendor').map((row) => { const output = { ...row }; delete output.vendor_name; return output; });
  res.json({ rows });
}));
router.get('/client-pending', requirePermission('clients.view'), asyncHandler(async (req, res) => res.json({ rows: await payments.listOutstanding('client', req.query) })));
router.get('/vendor-dues', requirePermission('vendors.view'), asyncHandler(async (req, res) => res.json({ rows: await payments.listOutstanding('vendor', req.query) })));
router.post('/sales/:saleId', (req, res, next) => requirePermission(req.body.partyType === 'vendor' ? 'payments.vendor.record' : 'payments.client.record')(req, res, next), validate('payment'), asyncHandler(async (req, res) => {
  const result = await payments.recordPayment(req, req.params.saleId, req.validated);
  res.status(201).json({ ...result, sale: sales.forRequest(req, result.sale) });
}));
router.post('/:id/reverse', requirePermission('payments.reverse'), asyncHandler(async (req, res) => {
  const result = await payments.reversePayment(req, req.params.id, String(req.body.reason || '').slice(0, 500));
  res.json({ ...result, sale: sales.forRequest(req, result.sale) });
}));
module.exports = router;
