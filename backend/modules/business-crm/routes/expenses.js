'use strict';
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const expenseService = require('../services/expenseService');
const money = require('../money');
const { asyncHandler, pageParams, safeLike } = require('../http');
const { validate } = require('../validation');
const { requirePermission } = require('../permissions');
const { httpError } = require('../services/salesService');
const router = express.Router();
function actor(req) { return String(req.userId || req.user?._id); }
function values(p) { return { date: p.expenseDate, category: p.category, description: p.description, payee: p.payee || null, amount: money.normalize(p.amount), currency: money.assertCurrency(p.currencyCode), method: p.method || null, reference: p.reference || null, notes: p.notes || null, key: p.idempotencyKey || null }; }
router.get('/', requirePermission('expenses.view'), asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query); const where = ['deleted_at IS NULL']; const params = { limit: pageSize, offset };
  if (req.query.currency) { where.push('currency_code=:currency'); params.currency = money.assertCurrency(req.query.currency); }
  if (req.query.from) { where.push('expense_date>=:fromDate'); params.fromDate = req.query.from; } if (req.query.to) { where.push('expense_date<=:toDate'); params.toDate = req.query.to; }
  if (req.query.q) { where.push('(description LIKE :q OR category LIKE :q OR payee LIKE :q)'); params.q = safeLike(req.query.q); }
  const [rows, counts] = await Promise.all([db.query(`SELECT * FROM biz_crm_expenses WHERE ${where.join(' AND ')} ORDER BY expense_date DESC,created_at DESC LIMIT :limit OFFSET :offset`, params), db.query(`SELECT COUNT(*) total FROM biz_crm_expenses WHERE ${where.join(' AND ')}`, params)]);
  res.json({ rows: rows.map((r) => ({ ...r, amount: money.normalize(r.amount) })), page, pageSize, total: Number(counts[0]?.total || 0) });
}));
router.post('/', requirePermission('expenses.manage'), validate('expenseCreate'), asyncHandler(async (req, res) => {
  res.status(201).json(await expenseService.createExpense(req, req.validated));
}));
router.put('/:id', requirePermission('expenses.manage'), validate('expenseUpdate'), asyncHandler(async (req, res) => {
  const p = values(req.validated); const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction(); const [beforeRows] = await connection.execute('SELECT * FROM biz_crm_expenses WHERE id=:id AND deleted_at IS NULL FOR UPDATE', { id: req.params.id });
    if (!beforeRows.length) throw httpError('Expense not found', 404); if (Number(beforeRows[0].version) !== Number(req.validated.version)) throw httpError('Version conflict', 409, 'VERSION_CONFLICT');
    await connection.execute(`UPDATE biz_crm_expenses SET expense_date=:date,category=:category,description=:description,payee=:payee,amount=:amount,currency_code=:currency,
      method=:method,reference=:reference,notes=:notes,updated_by=:actor,version=version+1 WHERE id=:id AND version=:version`, { ...p, actor: actor(req), id: req.params.id, version: req.validated.version });
    await audit.write(connection, req, 'expense.update', 'expense', req.params.id, beforeRows[0], p); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const rows = await db.query('SELECT * FROM biz_crm_expenses WHERE id=:id', { id: req.params.id }); res.json(rows[0]);
}));
router.delete('/:id', requirePermission('expenses.manage'), asyncHandler(async (req, res) => {
  const connection = await db.getPool().getConnection(); try { await connection.beginTransaction(); const [before] = await connection.execute('SELECT * FROM biz_crm_expenses WHERE id=:id FOR UPDATE', { id: req.params.id }); if (!before.length) throw httpError('Expense not found', 404);
    await connection.execute("UPDATE biz_crm_expenses SET status='void',deleted_at=NOW(),updated_by=:actor,version=version+1 WHERE id=:id", { actor: actor(req), id: req.params.id }); await audit.write(connection, req, 'expense.void', 'expense', req.params.id, before[0], { status: 'void' }); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); } res.json({ id: req.params.id, voided: true });
}));
module.exports = router;
