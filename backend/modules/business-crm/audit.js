'use strict';

const crypto = require('crypto');
const REDACT = /password|credential|cipher|token|secret|cookie/i;

function clean(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clean);
  const output = {};
  for (const [key, child] of Object.entries(value)) output[key] = REDACT.test(key) ? '[REDACTED]' : clean(child);
  return output;
}
function ip(req) {
  return String(req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}
async function write(connection, req, action, entityType = null, entityId = null, before = null, after = null) {
  await connection.execute(
    `INSERT INTO biz_crm_audit_logs
      (id, actor_user_id, actor_role, action_key, entity_type, entity_id, before_json, after_json, ip_address, user_agent, request_id)
     VALUES (:id,:actor,:role,:action,:entityType,:entityId,:beforeJson,:afterJson,:ip,:userAgent,:requestId)`,
    {
      id: crypto.randomUUID(), actor: String(req.userId || req.user?._id || 'system'), role: req.businessAccess?.role || req.userRole || null,
      action, entityType, entityId: entityId ? String(entityId) : null,
      beforeJson: before === null ? null : JSON.stringify(clean(before)), afterJson: after === null ? null : JSON.stringify(clean(after)),
      ip: ip(req), userAgent: String(req.get?.('user-agent') || '').slice(0, 500) || null, requestId: String(req.requestId || '').slice(0, 64) || null,
    },
  );
}
module.exports = { write, clean };
