'use strict';

const crypto = require('crypto');
const db = require('../db');
const money = require('../money');
const vault = require('../encryption');
const audit = require('../audit');

function httpError(message, status = 400, code = 'BUSINESS_ERROR') {
  return Object.assign(new Error(message), { status, code });
}
function uuid() { return crypto.randomUUID(); }
function userId(req) { return String(req.userId || req.user?._id); }
function decimal(value) { return money.normalize(value ?? '0'); }
function can(req, permission) { return Boolean(req.businessAccess?.permissions?.includes(permission)); }
function credentialSafeItems(req, items, oldById = new Map()) {
  if (can(req, 'credentials.manage')) return items;
  if (items.some((item) => item.credentialEmail || item.credentialPassword)) {
    throw httpError('Credential changes require explicit credential-management permission', 403, 'CREDENTIAL_PERMISSION_REQUIRED');
  }
  return items.map((item) => {
    const old = item.id ? oldById.get(item.id) : null;
    return {
      ...item,
      credentialEmail: '', credentialPassword: '',
      keepCredentialEmail: Boolean(old?.credential_email_ciphertext),
      keepCredentialPassword: Boolean(old?.credential_password_ciphertext),
    };
  });
}
async function protectedItems(connection, req, currency, items, oldById = new Map()) {
  if (can(req, 'profit.view')) return items.map((item) => ({ ...item, purchaseCost: decimal(item.purchaseCost) }));
  const output = [];
  for (const item of items) {
    const old = item.id ? oldById.get(item.id) : null;
    const sameProduct = old && String(old.product_id || '') === String(item.productId || '');
    if (sameProduct) { output.push({ ...item, purchaseCost: decimal(old.purchase_cost) }); continue; }
    if (!item.productId) throw httpError('Staff can add only catalogue products; custom purchase cost requires Manager access', 403, 'CUSTOM_COST_REQUIRES_MANAGER');
    const [products] = await connection.execute(`SELECT id,default_purchase_cost,currency_code,active FROM biz_crm_products WHERE id=:id AND deleted_at IS NULL LIMIT 1`, { id: item.productId });
    if (!products.length || !products[0].active) throw httpError('Catalogue product is unavailable', 409, 'PRODUCT_UNAVAILABLE');
    if (products[0].currency_code !== currency) throw httpError('Product currency must match the invoice currency', 409, 'PRODUCT_CURRENCY_MISMATCH');
    output.push({ ...item, purchaseCost: decimal(products[0].default_purchase_cost) });
  }
  return output;
}
function forRequest(req, sale) {
  const output = { ...sale, items: (sale.items || []).map((item) => ({ ...item })), payments: [...(sale.payments || [])] };
  delete output.idempotency_key;
  if (!can(req, 'profit.view')) {
    delete output.subtotal_cost; delete output.gross_profit;
    output.items = output.items.map((item) => { const next = { ...item }; delete next.purchase_cost; return next; });
  }
  if (!can(req, 'vendors.view')) {
    for (const key of ['vendor_id','vendor_name','vendor_whatsapp','vendor_email','vendor_company','vendor_paid','vendor_due']) delete output[key];
    output.payments = output.payments.filter((payment) => payment.party_type !== 'vendor');
  }
  return output;
}
function mapSale(row) {
  if (!row) return row;
  return {
    ...row,
    subtotal_sale: decimal(row.subtotal_sale), subtotal_cost: decimal(row.subtotal_cost),
    client_paid: decimal(row.client_paid), vendor_paid: decimal(row.vendor_paid),
    client_pending: money.nonNegative(money.subtract(row.subtotal_sale, row.client_paid)),
    vendor_due: money.nonNegative(money.subtract(row.subtotal_cost, row.vendor_paid)),
    gross_profit: money.subtract(row.subtotal_sale, row.subtotal_cost),
  };
}
function totals(items) {
  return {
    sale: money.sum(items.map((item) => item.salePrice)),
    cost: money.sum(items.map((item) => item.purchaseCost)),
  };
}
async function assertContact(connection, table, id, label) {
  if (!id) return null;
  const allowed = new Set(['biz_crm_clients', 'biz_crm_vendors']);
  if (!allowed.has(table)) throw new Error('Unsafe contact table');
  const [rows] = await connection.execute(`SELECT id FROM ${table} WHERE id=:id AND deleted_at IS NULL LIMIT 1`, { id });
  if (!rows.length) throw httpError(`${label} was not found`, 404, `${label.toUpperCase()}_NOT_FOUND`);
  return id;
}
async function nextInvoiceNumber(connection, saleDate) {
  const year = Number(String(saleDate).slice(0, 4));
  const [[settings]] = await connection.execute('SELECT invoice_prefix FROM biz_crm_settings WHERE id=1');
  const prefix = String(settings?.invoice_prefix || 'GDS').replace(/[^A-Z0-9-]/gi, '').toUpperCase() || 'GDS';
  await connection.execute(
    'INSERT INTO biz_crm_invoice_sequences (sequence_year,next_value) VALUES (:year,2) ON DUPLICATE KEY UPDATE next_value=LAST_INSERT_ID(next_value+1)',
    { year },
  );
  const [[sequenceRow]] = await connection.execute('SELECT next_value FROM biz_crm_invoice_sequences WHERE sequence_year=:year FOR UPDATE', { year });
  // INSERT starts at 2, therefore the first issued number is 1. Existing rows were
  // atomically incremented by LAST_INSERT_ID and expose the newly stored value.
  const sequence = Math.max(1, Number(sequenceRow.next_value) - 1);
  return `${prefix}-${year}-${String(sequence).padStart(6, '0')}`;
}
async function insertPayment(connection, req, sale, partyType, amount, paymentDate, method, idempotencyKey = null, notes = null) {
  if (money.compare(amount, '0') <= 0) return null;
  const limit = partyType === 'client' ? sale.subtotal_sale : sale.subtotal_cost;
  const paid = partyType === 'client' ? sale.client_paid : sale.vendor_paid;
  if (money.compare(money.sum([paid, amount]), limit) > 0) throw httpError(`${partyType} payment exceeds remaining balance`, 409, 'PAYMENT_EXCEEDS_BALANCE');
  const id = uuid();
  await connection.execute(
    `INSERT INTO biz_crm_payments
      (id,sale_id,party_type,amount,currency_code,payment_date,method,notes,idempotency_key,created_by)
     VALUES (:id,:saleId,:partyType,:amount,:currency,:paymentDate,:method,:notes,:idempotencyKey,:actor)`,
    { id, saleId: sale.id, partyType, amount: decimal(amount), currency: sale.currency_code, paymentDate, method: method || null, notes: notes || null, idempotencyKey: idempotencyKey || null, actor: userId(req) },
  );
  const column = partyType === 'client' ? 'client_paid' : 'vendor_paid';
  await connection.execute(`UPDATE biz_crm_sales SET ${column}=${column}+:amount, updated_by=:actor, version=version+1 WHERE id=:saleId`, { amount: decimal(amount), actor: userId(req), saleId: sale.id });
  return id;
}
async function createSale(req, payload) {
  return db.withTransaction(async (connection) => {
    await assertContact(connection, 'biz_crm_clients', payload.clientId, 'client');
    const vendorId = can(req, 'vendors.view') ? (payload.vendorId || null) : null;
    if (vendorId) await assertContact(connection, 'biz_crm_vendors', vendorId, 'vendor');
    if (money.compare(payload.openingClientPayment, '0') > 0 && !can(req, 'payments.client.record')) throw httpError('Client receipt permission is required', 403, 'PAYMENT_PERMISSION_REQUIRED');
    if (money.compare(payload.openingVendorPayment, '0') > 0 && !can(req, 'payments.vendor.record')) throw httpError('Vendor payment permission is required', 403, 'PAYMENT_PERMISSION_REQUIRED');
    const credentialItems = credentialSafeItems(req, payload.items);
    const currency = money.assertCurrency(payload.currencyCode);
    const effectiveItems = await protectedItems(connection, req, currency, credentialItems);
    const calculated = totals(effectiveItems);
    if (money.compare(payload.openingClientPayment, calculated.sale) > 0 || money.compare(payload.openingVendorPayment, calculated.cost) > 0) {
      throw httpError('Opening payment cannot exceed invoice total', 409, 'PAYMENT_EXCEEDS_BALANCE');
    }
    if (payload.idempotencyKey) {
      const [existing] = await connection.execute('SELECT id,created_by FROM biz_crm_sales WHERE idempotency_key=:key LIMIT 1', { key: payload.idempotencyKey });
      if (existing.length) {
        if (String(existing[0].created_by) !== userId(req)) throw httpError('Idempotency key belongs to another user', 409, 'SALE_IDEMPOTENCY_CONFLICT');
        return getSaleById(connection, existing[0].id, false);
      }
    }
    const sale = {
      id: uuid(), invoice_number: await nextInvoiceNumber(connection, payload.saleDate), client_id: payload.clientId,
      vendor_id: vendorId, sale_date: payload.saleDate, order_type: payload.orderType,
      currency_code: currency, subtotal_sale: calculated.sale, subtotal_cost: calculated.cost,
      client_paid: '0.00', vendor_paid: '0.00', notes: payload.notes || null,
      invoice_instructions: payload.invoiceInstructions || null,
    };
    await connection.execute(
      `INSERT INTO biz_crm_sales
       (id,invoice_number,client_id,vendor_id,sale_date,order_type,currency_code,subtotal_sale,subtotal_cost,notes,invoice_instructions,idempotency_key,created_by)
       VALUES (:id,:invoice_number,:client_id,:vendor_id,:sale_date,:order_type,:currency_code,:subtotal_sale,:subtotal_cost,:notes,:invoice_instructions,:idempotencyKey,:actor)`,
      { ...sale, idempotencyKey: payload.idempotencyKey || null, actor: userId(req) },
    );
    for (let index = 0; index < effectiveItems.length; index += 1) {
      const item = effectiveItems[index];
      const itemId = uuid();
      const context = `${sale.id}:${itemId}`;
      await connection.execute(
        `INSERT INTO biz_crm_sale_items
         (id,sale_id,product_id,name,account_type,duration_label,purchase_date,expiry_date,credential_email_ciphertext,credential_password_ciphertext,sale_price,purchase_cost,sort_order)
         VALUES (:id,:saleId,:productId,:name,:accountType,:durationLabel,:purchaseDate,:expiryDate,:emailCipher,:passwordCipher,:salePrice,:purchaseCost,:sortOrder)`,
        {
          id: itemId, saleId: sale.id, productId: item.productId || null, name: item.name, accountType: item.accountType,
          durationLabel: item.durationLabel || null, purchaseDate: item.purchaseDate || null, expiryDate: item.expiryDate || null,
          emailCipher: vault.encrypt(item.credentialEmail, `${context}:email`), passwordCipher: vault.encrypt(item.credentialPassword, `${context}:password`),
          salePrice: decimal(item.salePrice), purchaseCost: decimal(item.purchaseCost), sortOrder: index,
        },
      );
    }
    const paymentDate = payload.saleDate;
    await insertPayment(connection, req, sale, 'client', payload.openingClientPayment, paymentDate, payload.paymentMethod, payload.idempotencyKey ? `${payload.idempotencyKey}:client` : null, 'Opening payment');
    await insertPayment(connection, req, sale, 'vendor', payload.openingVendorPayment, paymentDate, payload.paymentMethod, payload.idempotencyKey ? `${payload.idempotencyKey}:vendor` : null, 'Opening vendor payment');
    await audit.write(connection, req, 'sale.create', 'sale', sale.id, null, { ...sale, itemCount: effectiveItems.length });
    return getSaleById(connection, sale.id, false);
  }, { isolation: 'SERIALIZABLE' });
}
async function getSaleById(connection, id, includeCredentials = false) {
  const [sales] = await connection.execute(
    `SELECT s.*, c.name client_name,c.whatsapp client_whatsapp,c.email client_email,c.company client_company,c.address client_address,
            v.name vendor_name,v.whatsapp vendor_whatsapp,v.email vendor_email,v.company vendor_company
       FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id
       LEFT JOIN biz_crm_vendors v ON v.id=s.vendor_id
      WHERE s.id=:id AND s.deleted_at IS NULL LIMIT 1`, { id },
  );
  if (!sales.length) throw httpError('Sale not found', 404, 'SALE_NOT_FOUND');
  const [items] = await connection.execute('SELECT * FROM biz_crm_sale_items WHERE sale_id=:id ORDER BY sort_order,id', { id });
  const mappedItems = items.map((item) => {
    const context = `${id}:${item.id}`;
    const output = {
      ...item, sale_price: decimal(item.sale_price), purchase_cost: decimal(item.purchase_cost),
      has_credential_email: Boolean(item.credential_email_ciphertext), has_credential_password: Boolean(item.credential_password_ciphertext),
    };
    if (includeCredentials) {
      output.credential_email = item.credential_email_ciphertext ? vault.decrypt(item.credential_email_ciphertext, `${context}:email`) : null;
      output.credential_password = item.credential_password_ciphertext ? vault.decrypt(item.credential_password_ciphertext, `${context}:password`) : null;
    }
    delete output.credential_email_ciphertext;
    delete output.credential_password_ciphertext;
    return output;
  });
  const [payments] = await connection.execute(
    `SELECT * FROM biz_crm_payments WHERE sale_id=:id ORDER BY payment_date DESC,created_at DESC`, { id },
  );
  return { ...mapSale(sales[0]), items: mappedItems, payments: payments.map((payment) => ({ ...payment, amount: decimal(payment.amount) })) };
}
async function getSale(id, includeCredentials = false) {
  const connection = await db.getPool().getConnection();
  try { return await getSaleById(connection, id, includeCredentials); }
  finally { connection.release(); }
}
async function listSales(filters = {}) {
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize || 25)));
  const where = ['s.deleted_at IS NULL'];
  const params = { limit: pageSize, offset: (page - 1) * pageSize };
  if (filters.currency) { where.push('s.currency_code=:currency'); params.currency = money.assertCurrency(filters.currency); }
  if (filters.status) { where.push('s.status=:status'); params.status = String(filters.status); }
  if (filters.from) { where.push('s.sale_date>=:fromDate'); params.fromDate = filters.from; }
  if (filters.to) { where.push('s.sale_date<=:toDate'); params.toDate = filters.to; }
  if (filters.clientId) { where.push('s.client_id=:clientId'); params.clientId = filters.clientId; }
  if (filters.vendorId) { where.push('s.vendor_id=:vendorId'); params.vendorId = filters.vendorId; }
  if (filters.q) {
    where.push('(s.invoice_number LIKE :q OR c.name LIKE :q OR EXISTS (SELECT 1 FROM biz_crm_sale_items si WHERE si.sale_id=s.id AND si.name LIKE :q))');
    params.q = `%${String(filters.q).replace(/[\\%_]/g, '\\$&').slice(0, 160)}%`;
  }
  const sqlWhere = where.join(' AND ');
  const [rows, countRows] = await Promise.all([
    db.query(
      `SELECT s.*,c.name client_name,v.name vendor_name,
              (s.subtotal_sale-s.client_paid) client_pending,(s.subtotal_cost-s.vendor_paid) vendor_due,
              (s.subtotal_sale-s.subtotal_cost) gross_profit,
              GROUP_CONCAT(si.name ORDER BY si.sort_order SEPARATOR ', ') item_names
         FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id LEFT JOIN biz_crm_vendors v ON v.id=s.vendor_id
         LEFT JOIN biz_crm_sale_items si ON si.sale_id=s.id
        WHERE ${sqlWhere} GROUP BY s.id ORDER BY s.sale_date DESC,s.created_at DESC LIMIT :limit OFFSET :offset`, params),
    db.query(`SELECT COUNT(*) total FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id WHERE ${sqlWhere}`, params),
  ]);
  return { rows: rows.map(mapSale), page, pageSize, total: Number(countRows[0]?.total || 0) };
}
async function updateSale(req, id, payload) {
  return db.withTransaction(async (connection) => {
    const before = await getSaleById(connection, id, true);
    if (Number(before.version) !== Number(payload.version)) throw httpError('Sale was modified by another user. Reload before saving.', 409, 'VERSION_CONFLICT');
    await assertContact(connection, 'biz_crm_clients', payload.clientId, 'client');
    const vendorId = can(req, 'vendors.view') ? (payload.vendorId || null) : before.vendor_id;
    if (vendorId) await assertContact(connection, 'biz_crm_vendors', vendorId, 'vendor');
    const currency = money.assertCurrency(payload.currencyCode);
    if ((money.compare(before.client_paid, '0') > 0 || money.compare(before.vendor_paid, '0') > 0) && currency !== before.currency_code) {
      throw httpError('Currency is locked after a payment has been posted', 409, 'CURRENCY_LOCKED');
    }
    const [oldItems] = await connection.execute('SELECT * FROM biz_crm_sale_items WHERE sale_id=:id', { id });
    const oldById = new Map(oldItems.map((item) => [item.id, item]));
    const credentialItems = credentialSafeItems(req, payload.items, oldById);
    const effectiveItems = await protectedItems(connection, req, currency, credentialItems, oldById);
    const calculated = totals(effectiveItems);
    if (money.compare(before.client_paid, calculated.sale) > 0 || money.compare(before.vendor_paid, calculated.cost) > 0) {
      throw httpError('New totals cannot be lower than posted payments', 409, 'TOTAL_BELOW_PAYMENTS');
    }
    const [result] = await connection.execute(
      `UPDATE biz_crm_sales SET client_id=:clientId,vendor_id=:vendorId,sale_date=:saleDate,order_type=:orderType,currency_code=:currency,
       subtotal_sale=:subtotalSale,subtotal_cost=:subtotalCost,notes=:notes,invoice_instructions=:instructions,updated_by=:actor,version=version+1
       WHERE id=:id AND version=:version AND deleted_at IS NULL`,
      { clientId: payload.clientId, vendorId, saleDate: payload.saleDate, orderType: payload.orderType, currency,
        subtotalSale: calculated.sale, subtotalCost: calculated.cost, notes: payload.notes || null, instructions: payload.invoiceInstructions || null,
        actor: userId(req), id, version: payload.version },
    );
    if (!result.affectedRows) throw httpError('Sale version conflict', 409, 'VERSION_CONFLICT');
    const keepIds = [];
    for (let index = 0; index < effectiveItems.length; index += 1) {
      const item = effectiveItems[index];
      const itemId = item.id && oldById.has(item.id) ? item.id : uuid();
      keepIds.push(itemId);
      const old = oldById.get(itemId);
      const context = `${id}:${itemId}`;
      const emailCipher = item.keepCredentialEmail && old ? old.credential_email_ciphertext : vault.encrypt(item.credentialEmail, `${context}:email`);
      const passwordCipher = item.keepCredentialPassword && old ? old.credential_password_ciphertext : vault.encrypt(item.credentialPassword, `${context}:password`);
      await connection.execute(
        `INSERT INTO biz_crm_sale_items
         (id,sale_id,product_id,name,account_type,duration_label,purchase_date,expiry_date,credential_email_ciphertext,credential_password_ciphertext,sale_price,purchase_cost,sort_order)
         VALUES (:itemId,:saleId,:productId,:name,:accountType,:durationLabel,:purchaseDate,:expiryDate,:emailCipher,:passwordCipher,:salePrice,:purchaseCost,:sortOrder)
         ON DUPLICATE KEY UPDATE product_id=VALUES(product_id),name=VALUES(name),account_type=VALUES(account_type),duration_label=VALUES(duration_label),
          purchase_date=VALUES(purchase_date),expiry_date=VALUES(expiry_date),credential_email_ciphertext=VALUES(credential_email_ciphertext),
          credential_password_ciphertext=VALUES(credential_password_ciphertext),sale_price=VALUES(sale_price),purchase_cost=VALUES(purchase_cost),sort_order=VALUES(sort_order)`,
        { itemId, saleId: id, productId: item.productId || null, name: item.name, accountType: item.accountType, durationLabel: item.durationLabel || null,
          purchaseDate: item.purchaseDate || null, expiryDate: item.expiryDate || null, emailCipher, passwordCipher,
          salePrice: decimal(item.salePrice), purchaseCost: decimal(item.purchaseCost), sortOrder: index },
      );
    }
    const deleteIds = oldItems.map((item) => item.id).filter((itemId) => !keepIds.includes(itemId));
    if (deleteIds.length) {
      const placeholders = deleteIds.map(() => '?').join(',');
      await connection.execute(`DELETE FROM biz_crm_sale_items WHERE sale_id=? AND id IN (${placeholders})`, [id, ...deleteIds]);
    }
    await audit.write(connection, req, 'sale.update', 'sale', id, before, { ...payload, items: effectiveItems, subtotalSale: calculated.sale, subtotalCost: calculated.cost });
    return getSaleById(connection, id, false);
  }, { isolation: 'SERIALIZABLE' });
}
async function setSaleStatus(req, id, status) {
  const allowed = new Set(['open', 'completed', 'cancelled']);
  if (!allowed.has(status)) throw httpError('Invalid sale status');
  return db.withTransaction(async (connection) => {
    const [locked] = await connection.execute('SELECT id FROM biz_crm_sales WHERE id=:id AND deleted_at IS NULL FOR UPDATE', { id });
    if (!locked.length) throw httpError('Sale not found', 404, 'SALE_NOT_FOUND');
    const before = await getSaleById(connection, id, false);
    if (status === 'cancelled' && (money.compare(before.client_paid, '0') > 0 || money.compare(before.vendor_paid, '0') > 0)) {
      throw httpError('Reverse posted client and vendor payments before cancelling this sale', 409, 'SALE_HAS_PAYMENTS');
    }
    await connection.execute('UPDATE biz_crm_sales SET status=:status,updated_by=:actor,version=version+1 WHERE id=:id', { status, actor: userId(req), id });
    await audit.write(connection, req, `sale.${status}`, 'sale', id, { status: before.status }, { status });
    return getSaleById(connection, id, false);
  });
}
async function softDeleteSale(req, id) {
  return db.withTransaction(async (connection) => {
    const [locked] = await connection.execute('SELECT id FROM biz_crm_sales WHERE id=:id AND deleted_at IS NULL FOR UPDATE', { id });
    if (!locked.length) throw httpError('Sale not found', 404, 'SALE_NOT_FOUND');
    const before = await getSaleById(connection, id, false);
    if (money.compare(before.client_paid, '0') > 0 || money.compare(before.vendor_paid, '0') > 0) throw httpError('Sales with payments cannot be deleted; cancel them instead', 409, 'SALE_HAS_PAYMENTS');
    await connection.execute('UPDATE biz_crm_sales SET deleted_at=NOW(),updated_by=:actor,version=version+1 WHERE id=:id', { actor: userId(req), id });
    await audit.write(connection, req, 'sale.delete', 'sale', id, before, { deleted: true });
    return { id, deleted: true };
  });
}

module.exports = { createSale, getSale, getSaleById, listSales, updateSale, setSaleStatus, softDeleteSale, mapSale, httpError, insertPayment, forRequest, protectedItems, credentialSafeItems };
