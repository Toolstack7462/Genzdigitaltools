'use strict';

const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const money = require('../money');
const { httpError } = require('./salesService');

function digits(value) { return String(value || '').replace(/\D/g, ''); }
function whatsappPhone(value, countryCode) {
  let phone = digits(value);
  if (!phone) throw httpError('WhatsApp number is missing', 409, 'WHATSAPP_MISSING');
  phone = phone.replace(/^00/, '');
  if (phone.startsWith('0')) phone = `${digits(countryCode)}${phone.slice(1)}`;
  return phone;
}
async function prepare(req, { reminderType, entityType, entityId }) {
  const settingsRows = await db.query('SELECT * FROM biz_crm_settings WHERE id=1');
  const settings = settingsRows[0] || {};
  let recipient; let message; let saleId = null;
  if (entityType === 'sale') {
    const rows = await db.query(
      `SELECT s.*,c.name client_name,c.whatsapp client_whatsapp,v.name vendor_name,v.whatsapp vendor_whatsapp
         FROM biz_crm_sales s JOIN biz_crm_clients c ON c.id=s.client_id LEFT JOIN biz_crm_vendors v ON v.id=s.vendor_id
        WHERE s.id=:id AND s.deleted_at IS NULL LIMIT 1`, { id: entityId },
    );
    if (!rows.length) throw httpError('Sale not found', 404, 'SALE_NOT_FOUND');
    const sale = rows[0]; saleId = sale.id;
    if (reminderType === 'vendor_due') {
      const due = money.nonNegative(money.subtract(sale.subtotal_cost, sale.vendor_paid));
      recipient = sale.vendor_whatsapp;
      message = `Assalam-o-Alaikum ${sale.vendor_name || 'Vendor'}, ${settings.store_name || 'Gen Z Digital Store'} ki taraf se ${sale.invoice_number} ka vendor due ${sale.currency_code} ${due} record hai. Payment coordination ke liye reply karein.`;
    } else {
      const pending = money.nonNegative(money.subtract(sale.subtotal_sale, sale.client_paid));
      recipient = sale.client_whatsapp;
      message = `Assalam-o-Alaikum ${sale.client_name}, ${settings.store_name || 'Gen Z Digital Store'} ki invoice ${sale.invoice_number} ka pending amount ${sale.currency_code} ${pending} hai. Meherbani karke payment update share karein. Shukriya.`;
    }
  } else if (entityType === 'sale_item' && reminderType === 'expiry') {
    const rows = await db.query(
      `SELECT i.id,i.name,i.expiry_date,s.id sale_id,s.invoice_number,c.name client_name,c.whatsapp client_whatsapp
         FROM biz_crm_sale_items i JOIN biz_crm_sales s ON s.id=i.sale_id JOIN biz_crm_clients c ON c.id=s.client_id
        WHERE i.id=:id AND s.deleted_at IS NULL LIMIT 1`, { id: entityId },
    );
    if (!rows.length) throw httpError('Expiry item not found', 404, 'ITEM_NOT_FOUND');
    const item = rows[0]; saleId = item.sale_id; recipient = item.client_whatsapp;
    message = `Assalam-o-Alaikum ${item.client_name}, aapka ${item.name} access ${item.expiry_date || 'jaldi'} expire ho raha hai. Renewal ke liye ${settings.store_name || 'Gen Z Digital Store'} ko reply karein.`;
  } else throw httpError('Unsupported reminder type', 400, 'REMINDER_UNSUPPORTED');
  const phone = whatsappPhone(recipient, settings.whatsapp_country_code || '92');
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
module.exports = { prepare, markOpened, whatsappPhone };
