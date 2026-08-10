'use strict';

const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const money = require('../money');
const vault = require('../encryption');
const { httpError } = require('./salesService');
const templates = require('../reminderTemplates');

// Reminder types this service knows how to compose, and the entity each one is prepared against.
// Anything else is refused with 400 rather than silently falling through to a payment reminder.
const SALE_TYPES = Object.freeze({
  client_pending: 'payment',
  client_overdue: 'overdue',
  invoice_share: 'invoice',
  vendor_due: 'vendor',
});
const ITEM_TYPES = Object.freeze({
  expiry: 'auto',
  expiring_soon: 'expiring',
  renewal_due_today: 'due_today',
  expired: 'expired',
});

function digits(value) { return String(value || '').replace(/\D/g, ''); }
function whatsappPhone(value, countryCode) {
  let phone = digits(value);
  if (!phone) throw httpError('WhatsApp number is missing', 409, 'WHATSAPP_MISSING');
  phone = phone.replace(/^00/, '');
  if (phone.startsWith('0')) phone = `${digits(countryCode)}${phone.slice(1)}`;
  return phone;
}

/**
 * Decrypts an item's account email for MASKING only.
 *
 * The plaintext never leaves this function: the caller receives whatever `maskEmail` returns. If the
 * vault key is missing or a value fails to decrypt, the email is simply omitted — a reminder must not
 * fail because one optional field is unavailable. The password ciphertext is never even selected.
 */
function accountEmailFor(saleId, item) {
  if (!item.credential_email_ciphertext || !vault.configured()) return null;
  try {
    return vault.decrypt(item.credential_email_ciphertext, `${saleId}:${item.id}:email`);
  } catch {
    return null;
  }
}

async function itemsForSale(saleId) {
  const rows = await db.query(
    `SELECT id,name,duration_label,purchase_date,expiry_date,credential_email_ciphertext
       FROM biz_crm_sale_items WHERE sale_id=:saleId ORDER BY sort_order,id`,
    { saleId },
  );
  return (rows || []).map((item) => ({
    name: item.name,
    accountEmail: accountEmailFor(saleId, item),
    purchaseDate: item.purchase_date,
    expiryDate: item.expiry_date,
    durationLabel: item.duration_label,
  }));
}

async function loadSale(entityId) {
  const rows = await db.query(
    `SELECT s.*,c.name client_name,c.whatsapp client_whatsapp,v.name vendor_name,v.whatsapp vendor_whatsapp
       FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id LEFT JOIN biz_crm_vendors v ON v.id=s.vendor_id
      WHERE s.id=:id AND s.deleted_at IS NULL LIMIT 1`, { id: entityId },
  );
  if (!rows.length) throw httpError('Sale not found', 404, 'SALE_NOT_FOUND');
  return rows[0];
}

/**
 * Refuses a payment reminder for an invoice with nothing outstanding.
 *
 * A settled or cancelled invoice must never produce a "you owe us" message — that is a customer-facing
 * error the operator cannot take back. Returned as 409 with a specific code so the UI can explain it
 * instead of showing a generic failure.
 */
function assertPayable(sale, pending) {
  if (String(sale.status || '').toLowerCase() === 'cancelled') {
    throw httpError('This invoice is cancelled, so no payment reminder can be sent.', 409, 'REMINDER_NOT_PAYABLE');
  }
  if (money.compare(pending, '0.00') <= 0) {
    throw httpError('This invoice is fully paid, so there is no outstanding balance to remind about.', 409, 'REMINDER_NOT_PAYABLE');
  }
}

async function composeForSale(req, sale, kind, settings) {
  const pending = money.nonNegative(money.subtract(sale.subtotal_sale, sale.client_paid));
  if (kind === 'vendor') {
    const due = money.nonNegative(money.subtract(sale.subtotal_cost, sale.vendor_paid));
    return {
      recipient: sale.vendor_whatsapp,
      message: templates.vendorDueReminder({
        vendorName: sale.vendor_name, invoiceNumber: sale.invoice_number,
        currency: sale.currency_code, dueAmount: due, storeName: settings.store_name,
      }),
    };
  }
  const shared = {
    clientName: sale.client_name,
    invoiceNumber: sale.invoice_number,
    currency: sale.currency_code,
    invoiceTotal: money.normalize(sale.subtotal_sale),
    amountReceived: money.normalize(sale.client_paid),
    pendingAmount: pending,
    items: await itemsForSale(sale.id),
    storeName: settings.store_name,
  };
  if (kind === 'invoice') {
    // Invoice sharing is a statement, not a demand, so it is allowed for a settled invoice too.
    return { recipient: sale.client_whatsapp, message: templates.invoiceShareReminder({ ...shared, invoiceDate: sale.sale_date }) };
  }
  assertPayable(sale, pending);
  if (kind === 'overdue') {
    return { recipient: sale.client_whatsapp, message: templates.overduePaymentReminder({ ...shared, dueSince: sale.sale_date }) };
  }
  return { recipient: sale.client_whatsapp, message: templates.paymentReminder(shared) };
}

async function composeForItem(entityId, kind, settings) {
  const rows = await db.query(
    `SELECT i.id,i.name,i.duration_label,i.purchase_date,i.expiry_date,i.sale_price,i.credential_email_ciphertext,
            s.id sale_id,s.invoice_number,s.currency_code,c.name client_name,c.whatsapp client_whatsapp
       FROM biz_crm_sale_items i JOIN biz_crm_sales s ON s.id=i.sale_id JOIN biz_crm_clients c ON c.id=s.client_id
      WHERE i.id=:id AND s.deleted_at IS NULL LIMIT 1`, { id: entityId },
  );
  if (!rows.length) throw httpError('Expiry item not found', 404, 'ITEM_NOT_FOUND');
  const item = rows[0];
  const fields = {
    clientName: item.client_name,
    productName: item.name,
    accountEmail: accountEmailFor(item.sale_id, item),
    purchaseDate: item.purchase_date,
    expiryDate: item.expiry_date,
    renewalPeriod: item.duration_label,
    // The renewal price quoted is what this item last sold for, in the sale's own currency. It is
    // omitted by the template when it is zero or absent, rather than quoting a free renewal.
    renewalAmount: item.sale_price,
    currency: item.currency_code,
    invoiceNumber: item.invoice_number,
    storeName: settings.store_name,
  };
  const message = kind === 'expiring' ? templates.expiringSoonReminder(fields)
    : kind === 'due_today' ? templates.renewalDueTodayReminder(fields)
      : kind === 'expired' ? templates.expiredReminder(fields)
        : templates.renewalReminder(fields);
  return { recipient: item.client_whatsapp, message, saleId: item.sale_id };
}

async function prepare(req, { reminderType, entityType, entityId }) {
  const settingsRows = await db.query('SELECT * FROM biz_crm_settings WHERE id=1');
  const settings = settingsRows[0] || {};
  let composed; let saleId = null;

  if (entityType === 'sale' && SALE_TYPES[reminderType]) {
    const sale = await loadSale(entityId);
    saleId = sale.id;
    composed = await composeForSale(req, sale, SALE_TYPES[reminderType], settings);
  } else if (entityType === 'sale_item' && ITEM_TYPES[reminderType]) {
    composed = await composeForItem(entityId, ITEM_TYPES[reminderType], settings);
    saleId = composed.saleId;
  } else throw httpError('Unsupported reminder type', 400, 'REMINDER_UNSUPPORTED');

  const message = composed.message;
  const phone = whatsappPhone(composed.recipient, settings.whatsapp_country_code || '92');
  const id = crypto.randomUUID();
  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO biz_crm_reminders (id,reminder_type,entity_type,entity_id,recipient,channel,message_text,status,prepared_by)
       VALUES (:id,:reminderType,:entityType,:entityId,:recipient,'whatsapp',:message,'prepared',:actor)`,
      { id, reminderType, entityType, entityId, recipient: phone, message, actor: String(req.userId || req.user?._id) },
    );
    await audit.write(connection, req, 'reminder.prepare', entityType, entityId, null, { id, reminderType, channel: 'whatsapp', saleId });
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return { id, channel: 'whatsapp', status: 'prepared', message, recipient: phone, url: `https://wa.me/${phone}?text=${encodeURIComponent(message)}` };
}

async function markOpened(req, id) {
  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM biz_crm_reminders WHERE id=:id FOR UPDATE', { id });
    if (!rows.length) throw httpError('Reminder not found', 404, 'REMINDER_NOT_FOUND');
    await connection.execute("UPDATE biz_crm_reminders SET status='opened',opened_at=COALESCE(opened_at,NOW()) WHERE id=:id", { id });
    await audit.write(connection, req, 'reminder.open', rows[0].entity_type, rows[0].entity_id, { status: rows[0].status }, { status: 'opened' });
    await connection.commit();
    return { id, status: 'opened' };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

module.exports = { prepare, markOpened, whatsappPhone, SALE_TYPES, ITEM_TYPES };
