'use strict';
const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const { httpError } = require('./salesService');
const CONFIG = {
  clients: { table: 'biz_crm_clients', singular: 'client' },
  vendors: { table: 'biz_crm_vendors', singular: 'vendor' },
};
function actor(req) { return String(req.userId || req.user?._id); }
function forResponse(row) { if (!row) return row; const output = { ...row }; delete output.idempotency_key; return output; }
function params(value) { return { name: value.name, whatsapp: value.whatsapp || null, email: value.email || null, company: value.company || null, address: value.address || null, taxId: value.taxId || null, notes: value.notes || null, status: value.status || 'active', idempotencyKey: value.idempotencyKey || null }; }
async function createContact(req, kind, value) {
  const config = CONFIG[kind]; if (!config) throw httpError('Unknown contact module', 404);
  const id = crypto.randomUUID(); const payload = params(value); const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction();
    if (payload.idempotencyKey) {
      const [existing] = await connection.execute(`SELECT * FROM ${config.table} WHERE idempotency_key=:key LIMIT 1`, { key: payload.idempotencyKey });
      if (existing.length) {
        if (String(existing[0].created_by) !== actor(req)) throw httpError('Idempotency key belongs to another user', 409, 'CONTACT_IDEMPOTENCY_CONFLICT');
        await connection.rollback(); return forResponse(existing[0]);
      }
    }
    await connection.execute(`INSERT INTO ${config.table} (id,name,whatsapp,email,company,address,tax_id,notes,status,idempotency_key,created_by) VALUES (:id,:name,:whatsapp,:email,:company,:address,:taxId,:notes,:status,:idempotencyKey,:actor)`, { id, ...payload, actor: actor(req) }); await audit.write(connection, req, `${config.singular}.create`, config.singular, id, null, payload); await connection.commit(); }
  catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const rows = await db.query(`SELECT * FROM ${config.table} WHERE id=:id`, { id }); return forResponse(rows[0]);
}
module.exports = { CONFIG, createContact, params, forResponse };
