'use strict';

const crypto = require('crypto');
const db = require('../db');
const money = require('../money');
const audit = require('../audit');
const { getSaleById, httpError } = require('./salesService');

function actor(req) { return String(req.userId || req.user?._id); }
function decimal(value) { return money.normalize(value ?? '0'); }

async function recordPayment(req, saleId, payload) {
  return db.withTransaction(async (connection) => {
    const [rows] = await connection.execute('SELECT * FROM biz_crm_sales WHERE id=:id AND deleted_at IS NULL FOR UPDATE', { id: saleId });
    if (!rows.length) throw httpError('Sale not found', 404, 'SALE_NOT_FOUND');
    const sale = rows[0];
    if (sale.status === 'cancelled') throw httpError('Cannot post payment against a cancelled sale', 409, 'SALE_CANCELLED');
    const amount = decimal(payload.amount);
    if (payload.idempotencyKey) {
      const [existing] = await connection.execute('SELECT * FROM biz_crm_payments WHERE idempotency_key=:key LIMIT 1', { key: payload.idempotencyKey });
      if (existing.length) {
        const previous = existing[0];
        const sameOperation = String(previous.created_by) === actor(req)
          && String(previous.sale_id) === String(saleId)
          && previous.party_type === payload.partyType
          && money.compare(previous.amount, amount) === 0;
        if (!sameOperation) throw httpError('Idempotency key belongs to a different payment', 409, 'PAYMENT_IDEMPOTENCY_CONFLICT');
        return { payment: { ...previous, amount: decimal(previous.amount) }, sale: await getSaleById(connection, saleId, false), replayed: true };
      }
    }
    if (money.compare(amount, '0') <= 0) throw httpError('Payment must be greater than zero');
    const total = payload.partyType === 'client' ? sale.subtotal_sale : sale.subtotal_cost;
    const paid = payload.partyType === 'client' ? sale.client_paid : sale.vendor_paid;
    const after = money.sum([paid, amount]);
    if (money.compare(after, total) > 0) throw httpError('Payment exceeds remaining balance', 409, 'PAYMENT_EXCEEDS_BALANCE');
    const id = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO biz_crm_payments
       (id,sale_id,party_type,amount,currency_code,payment_date,method,reference,notes,idempotency_key,created_by)
       VALUES (:id,:saleId,:partyType,:amount,:currency,:paymentDate,:method,:reference,:notes,:key,:actor)`,
      { id, saleId, partyType: payload.partyType, amount, currency: sale.currency_code, paymentDate: payload.paymentDate,
        method: payload.method || null, reference: payload.reference || null, notes: payload.notes || null,
        key: payload.idempotencyKey || null, actor: actor(req) },
    );
    const column = payload.partyType === 'client' ? 'client_paid' : 'vendor_paid';
    await connection.execute(`UPDATE biz_crm_sales SET ${column}=:after,updated_by=:actor,version=version+1 WHERE id=:saleId`, { after, actor: actor(req), saleId });
    await audit.write(connection, req, `payment.${payload.partyType}.record`, 'payment', id, null, { saleId, amount, currency: sale.currency_code, paymentDate: payload.paymentDate });
    const [paymentRows] = await connection.execute('SELECT * FROM biz_crm_payments WHERE id=:id', { id });
    return { payment: { ...paymentRows[0], amount }, sale: await getSaleById(connection, saleId, false), replayed: false };
  }, { isolation: 'SERIALIZABLE' });
}

async function reversePayment(req, paymentId, reason = '') {
  return db.withTransaction(async (connection) => {
    const [rows] = await connection.execute('SELECT * FROM biz_crm_payments WHERE id=:id FOR UPDATE', { id: paymentId });
    if (!rows.length) throw httpError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    const payment = rows[0];
    if (payment.status !== 'posted' || payment.reverses_payment_id) throw httpError('Payment is not eligible for reversal', 409, 'PAYMENT_NOT_REVERSIBLE');
    const [existing] = await connection.execute('SELECT id FROM biz_crm_payments WHERE reverses_payment_id=:id LIMIT 1', { id: paymentId });
    if (existing.length) throw httpError('Payment has already been reversed', 409, 'PAYMENT_ALREADY_REVERSED');
    const [saleRows] = await connection.execute('SELECT * FROM biz_crm_sales WHERE id=:id FOR UPDATE', { id: payment.sale_id });
    if (!saleRows.length) throw httpError('Sale not found', 404, 'SALE_NOT_FOUND');
    const sale = saleRows[0];
    const column = payment.party_type === 'client' ? 'client_paid' : 'vendor_paid';
    const current = sale[column];
    const after = money.subtract(current, payment.amount);
    if (money.compare(after, '0') < 0) throw httpError('Reversal would create a negative ledger balance', 409, 'NEGATIVE_LEDGER');
    const reversalId = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO biz_crm_payments
       (id,sale_id,party_type,amount,currency_code,payment_date,method,reference,notes,status,reverses_payment_id,created_by)
       VALUES (:id,:saleId,:partyType,:amount,:currency,CURRENT_DATE,'reversal',:reference,:notes,'posted',:original,:actor)`,
      { id: reversalId, saleId: payment.sale_id, partyType: payment.party_type, amount: `-${decimal(payment.amount)}`, currency: payment.currency_code,
        reference: payment.reference || null, notes: reason || 'Payment reversal', original: paymentId, actor: actor(req) },
    );
    await connection.execute('UPDATE biz_crm_payments SET status=\'reversed\',reversed_by=:actor,reversed_at=NOW() WHERE id=:id', { actor: actor(req), id: paymentId });
    await connection.execute(`UPDATE biz_crm_sales SET ${column}=:after,updated_by=:actor,version=version+1 WHERE id=:saleId`, { after, actor: actor(req), saleId: payment.sale_id });
    await audit.write(connection, req, 'payment.reverse', 'payment', paymentId, payment, { reversalId, reason, balanceAfter: after });
    return { reversedPaymentId: paymentId, reversalId, sale: await getSaleById(connection, payment.sale_id, false) };
  }, { isolation: 'SERIALIZABLE' });
}

async function listOutstanding(partyType, filters = {}) {
  if (!['client', 'vendor'].includes(partyType)) throw httpError('Invalid ledger party');
  const totalColumn = partyType === 'client' ? 'subtotal_sale' : 'subtotal_cost';
  const paidColumn = partyType === 'client' ? 'client_paid' : 'vendor_paid';
  const contactJoin = partyType === 'client' ? 'JOIN biz_crm_clients p ON p.id=s.client_id' : 'JOIN biz_crm_vendors p ON p.id=s.vendor_id';
  const where = ['s.deleted_at IS NULL', 's.status<>\'cancelled\'', `s.${totalColumn}>s.${paidColumn}`];
  const params = {};
  if (filters.currency) { where.push('s.currency_code=:currency'); params.currency = money.assertCurrency(filters.currency); }
  if (filters.q) { where.push('(s.invoice_number LIKE :q OR p.name LIKE :q OR p.whatsapp LIKE :q)'); params.q = `%${String(filters.q).slice(0, 160)}%`; }
  const rows = await db.query(
    `SELECT s.id,s.invoice_number,s.sale_date,s.currency_code,s.${totalColumn} total_amount,s.${paidColumn} paid_amount,
            (s.${totalColumn}-s.${paidColumn}) pending_amount,p.id party_id,p.name party_name,p.whatsapp,p.email
       FROM biz_crm_sales s ${contactJoin} WHERE ${where.join(' AND ')} ORDER BY s.sale_date ASC,s.created_at ASC`, params,
  );
  return rows.map((row) => ({ ...row, total_amount: decimal(row.total_amount), paid_amount: decimal(row.paid_amount), pending_amount: decimal(row.pending_amount) }));
}

async function listPayments(filters = {}) {
  const where = ['1=1']; const params = {};
  if (filters.saleId) { where.push('p.sale_id=:saleId'); params.saleId = filters.saleId; }
  if (filters.partyType) { where.push('p.party_type=:partyType'); params.partyType = filters.partyType; }
  if (filters.currency) { where.push('p.currency_code=:currency'); params.currency = money.assertCurrency(filters.currency); }
  if (filters.from) { where.push('p.payment_date>=:fromDate'); params.fromDate = filters.from; }
  if (filters.to) { where.push('p.payment_date<=:toDate'); params.toDate = filters.to; }
  const rows = await db.query(
    `SELECT p.*,s.invoice_number,c.name client_name,v.name vendor_name
       FROM biz_crm_payments p JOIN biz_crm_sales s ON s.id=p.sale_id JOIN biz_crm_clients c ON c.id=s.client_id LEFT JOIN biz_crm_vendors v ON v.id=s.vendor_id
      WHERE ${where.join(' AND ')} ORDER BY p.payment_date DESC,p.created_at DESC LIMIT 1000`, params,
  );
  return rows.map((row) => ({ ...row, amount: decimal(row.amount) }));
}

module.exports = { recordPayment, reversePayment, listOutstanding, listPayments };
