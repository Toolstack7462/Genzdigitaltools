'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { asyncHandler } = require('../http');
const { requirePermission, has } = require('../permissions');
const { schemas } = require('../validation');
const sales = require('../services/salesService');
const payments = require('../services/paymentService');
const expenses = require('../services/expenseService');
const contacts = require('../services/contactService');
const money = require('../money');
const router = express.Router();
const SENSITIVE = /password|credential|token|secret|cookie|authorization|vault/i;
function hasSensitive(value) { if (!value || typeof value !== 'object') return false; if (Array.isArray(value)) return value.some(hasSensitive); return Object.entries(value).some(([key, child]) => SENSITIVE.test(key) || hasSensitive(child)); }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validate(schema, payload) { const result = schema.validate(payload, { abortEarly: false, stripUnknown: true, convert: true }); if (result.error) throw Object.assign(new Error(result.error.details.map((x) => x.message).join('; ')), { status: 400, code: 'OFFLINE_VALIDATION_ERROR' }); return result.value; }
function assertPermission(req, permission) { if (!has(req, permission)) throw Object.assign(new Error(`Permission required: ${permission}`), { status: 403, code: 'BUSINESS_PERMISSION_DENIED' }); }
async function recoverCommitted(req, type, key) {
  if (type === 'sale.create') {
    const rows = await db.query('SELECT id FROM biz_crm_sales WHERE idempotency_key=:key LIMIT 1', { key });
    return rows.length ? sales.forRequest(req, await sales.getSale(rows[0].id, false)) : null;
  }
  if (type === 'payment.create') {
    const rows = await db.query('SELECT * FROM biz_crm_payments WHERE idempotency_key=:key LIMIT 1', { key });
    if (!rows.length) return null;
    const payment = { ...rows[0], amount: money.normalize(rows[0].amount) };
    return { payment, sale: sales.forRequest(req, await sales.getSale(rows[0].sale_id, false)), replayed: true };
  }
  if (type === 'expense.create') {
    const rows = await db.query('SELECT * FROM biz_crm_expenses WHERE idempotency_key=:key LIMIT 1', { key });
    if (!rows.length) return null; const result = { ...rows[0] }; delete result.idempotency_key; return result;
  }
  if (type === 'client.create' || type === 'vendor.create') {
    const table = type === 'client.create' ? 'biz_crm_clients' : 'biz_crm_vendors';
    const rows = await db.query(`SELECT * FROM ${table} WHERE idempotency_key=:key LIMIT 1`, { key });
    if (!rows.length) return null; const result = { ...rows[0] }; delete result.idempotency_key; return result;
  }
  return null;
}
router.post('/batch', requirePermission('offline.sync'), asyncHandler(async (req, res) => {
  const deviceId = String(req.body.deviceId || '').slice(0, 100); const operations = Array.isArray(req.body.operations) ? req.body.operations.slice(0, 50) : [];
  if (!deviceId || !operations.length) return res.status(400).json({ error: 'deviceId and operations are required' }); const results = [];
  for (const operation of operations) {
    const key = String(operation.idempotencyKey || '').slice(0, 128); const type = String(operation.type || ''); const payload = operation.payload || {};
    const actorId = String(req.userId); const queuedByUserId = String(operation.userId || '');
    if (!key || queuedByUserId !== actorId) { results.push({ idempotencyKey: key, status: 'rejected', error: 'Queued operation belongs to a different or unknown user', code: 'SYNC_USER_MISMATCH' }); continue; }
    if (hasSensitive(payload)) { results.push({ idempotencyKey: key, status: 'rejected', error: 'Sensitive fields are never accepted from offline storage' }); continue; }
    const payloadHash = hash({ type, payload });
    const insertResult = await db.query(`INSERT IGNORE INTO biz_crm_sync_operations (idempotency_key,device_id,user_id,operation_type,payload_hash,status) VALUES (:key,:device,:actor,:type,:hash,'processing')`, { key, device: deviceId, actor: actorId, type, hash: payloadHash });
    if (!insertResult.affectedRows) {
      const existing = await db.query('SELECT * FROM biz_crm_sync_operations WHERE idempotency_key=:key LIMIT 1', { key });
      const stored = existing[0];
      if (!stored || String(stored.user_id) !== actorId || stored.payload_hash !== payloadHash || stored.operation_type !== type) {
        results.push({ idempotencyKey: key, status: 'rejected', error: 'Idempotency key belongs to a different operation', code: 'SYNC_KEY_CONFLICT' }); continue;
      }
      if (stored.status === 'processing') {
        const recovered = await recoverCommitted(req, type, key);
        if (recovered) {
          await db.query("UPDATE biz_crm_sync_operations SET status='completed',result_json=:result,completed_at=NOW() WHERE idempotency_key=:key", { result: JSON.stringify(recovered), key });
          results.push({ idempotencyKey: key, status: 'completed', result: recovered, replayed: true, recovered: true }); continue;
        }
      }
      results.push({ idempotencyKey: key, status: stored.status, result: stored.result_json ? JSON.parse(stored.result_json) : null, replayed: true }); continue;
    }
    try {
      let result;
      if (type === 'sale.create') { assertPermission(req, 'sales.create'); result = sales.forRequest(req, await sales.createSale(req, validate(schemas.saleCreate, { ...payload, idempotencyKey: key }))); }
      else if (type === 'payment.create') { assertPermission(req, payload.partyType === 'vendor' ? 'payments.vendor.record' : 'payments.client.record'); const paymentResult = await payments.recordPayment(req, String(payload.saleId), validate(schemas.payment, { ...payload, idempotencyKey: key })); result = { ...paymentResult, sale: sales.forRequest(req, paymentResult.sale) }; }
      else if (type === 'expense.create') { assertPermission(req, 'expenses.manage'); result = await expenses.createExpense(req, validate(schemas.expenseCreate, { ...payload, idempotencyKey: key })); }
      else if (type === 'client.create') { assertPermission(req, 'clients.create'); result = await contacts.createContact(req, 'clients', validate(schemas.clientCreate, { ...payload, idempotencyKey: key })); }
      else if (type === 'vendor.create') { assertPermission(req, 'vendors.create'); result = await contacts.createContact(req, 'vendors', validate(schemas.vendorCreate, { ...payload, idempotencyKey: key })); }
      else throw Object.assign(new Error('Unsupported offline operation'), { status: 400, code: 'OFFLINE_OPERATION_UNSUPPORTED' });
      await db.query("UPDATE biz_crm_sync_operations SET status='completed',result_json=:result,completed_at=NOW() WHERE idempotency_key=:key", { result: JSON.stringify(result), key }); results.push({ idempotencyKey: key, status: 'completed', result });
    } catch (error) { const failure = { error: error.message, code: error.code || 'SYNC_FAILED' }; await db.query("UPDATE biz_crm_sync_operations SET status='failed',result_json=:result,completed_at=NOW() WHERE idempotency_key=:key", { result: JSON.stringify(failure), key }); results.push({ idempotencyKey: key, status: 'failed', ...failure }); }
  }
  res.json({ deviceId, results });
}));
router.get('/status', requirePermission('offline.sync'), asyncHandler(async (req, res) => { const rows = await db.query('SELECT idempotency_key,device_id,operation_type,status,result_json,created_at,completed_at FROM biz_crm_sync_operations WHERE user_id=:actor ORDER BY created_at DESC LIMIT 100', { actor: String(req.userId) }); res.json({ rows: rows.map((r) => ({ ...r, result: r.result_json ? JSON.parse(r.result_json) : null, result_json: undefined })) }); }));
module.exports = router;
