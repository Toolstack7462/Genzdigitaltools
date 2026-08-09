'use strict';
const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const money = require('../money');
function actor(req) { return String(req.userId || req.user?._id); }
function values(value) { return { date: value.expenseDate, category: value.category, description: value.description, payee: value.payee || null, amount: money.normalize(value.amount), currency: money.assertCurrency(value.currencyCode), method: value.method || null, reference: value.reference || null, notes: value.notes || null, key: value.idempotencyKey || null }; }
async function createExpense(req, value) {
  const id = crypto.randomUUID(); const payload = values(value); const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction();
    if (payload.key) { const [existing] = await connection.execute('SELECT * FROM biz_crm_expenses WHERE idempotency_key=:key LIMIT 1', { key: payload.key }); if (existing.length) { await connection.rollback(); return existing[0]; } }
    await connection.execute(`INSERT INTO biz_crm_expenses (id,expense_date,category,description,payee,amount,currency_code,method,reference,notes,idempotency_key,created_by) VALUES (:id,:date,:category,:description,:payee,:amount,:currency,:method,:reference,:notes,:key,:actor)`, { id, ...payload, actor: actor(req) });
    await audit.write(connection, req, 'expense.create', 'expense', id, null, payload); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const rows = await db.query('SELECT * FROM biz_crm_expenses WHERE id=:id', { id }); return rows[0];
}
module.exports = { createExpense, values };
