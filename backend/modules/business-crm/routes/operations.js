'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const audit = require('../audit');
const { asyncHandler } = require('../http');
const { validate } = require('../validation');
const { requirePermission, has } = require('../permissions');
const reminders = require('../services/reminderService');
const { httpError } = require('../services/salesService');
const router = express.Router();
function actor(req) { return String(req.userId || req.user?._id); }
const ACTIVITY_ENTITIES = Object.freeze({
  client: { table: 'biz_crm_clients', permission: 'clients.view' },
  vendor: { table: 'biz_crm_vendors', permission: 'vendors.view' },
  sale: { table: 'biz_crm_sales', permission: 'sales.view' },
});
async function assertActivityEntity(req, entityType, entityId) {
  const config = ACTIVITY_ENTITIES[entityType];
  if (!config) throw httpError('Unsupported activity entity', 400, 'ACTIVITY_ENTITY_INVALID');
  if (!has(req, config.permission)) throw httpError(`Permission required: ${config.permission}`, 403, 'BUSINESS_PERMISSION_DENIED');
  const rows = await db.query(`SELECT id FROM ${config.table} WHERE id=:id AND deleted_at IS NULL LIMIT 1`, { id: entityId });
  if (!rows.length) throw httpError('Activity entity not found', 404, 'ACTIVITY_ENTITY_NOT_FOUND');
}
function staffTaskScope(req, task) {
  if (req.businessAccess?.role !== 'STAFF') return;
  const user = actor(req);
  if (String(task.assigned_user_id || '') !== user && String(task.created_by || '') !== user) throw httpError('This task is outside your assigned scope', 403, 'TASK_SCOPE_DENIED');
}
function assignedUser(req, requested) {
  if (req.businessAccess?.role !== 'STAFF') return requested || null;
  if (requested && String(requested) !== actor(req)) throw httpError('Staff can assign tasks only to themselves', 403, 'TASK_ASSIGNMENT_DENIED');
  return actor(req);
}
router.get('/tasks', requirePermission('tasks.view'), asyncHandler(async (req, res) => {
  const where = ['t.deleted_at IS NULL']; const params = {};
  if (req.businessAccess?.role === 'STAFF') { where.push('(t.assigned_user_id=:scopeActor OR t.created_by=:scopeActor)'); params.scopeActor = actor(req); }
  if (req.query.status) { where.push('t.status=:status'); params.status = req.query.status; }
  if (req.query.mine === '1') { where.push('t.assigned_user_id=:actor'); params.actor = actor(req); }
  if (req.query.overdue === '1') where.push("t.due_at<NOW() AND t.status NOT IN ('completed','cancelled')");
  const rows = await db.query(`SELECT t.*,c.name client_name,v.name vendor_name,s.invoice_number FROM biz_crm_tasks t
    LEFT JOIN biz_crm_clients c ON c.id=t.client_id LEFT JOIN biz_crm_vendors v ON v.id=t.vendor_id LEFT JOIN biz_crm_sales s ON s.id=t.sale_id
    WHERE ${where.join(' AND ')} ORDER BY FIELD(t.priority,'urgent','high','normal','low'),t.due_at IS NULL,t.due_at LIMIT 1000`, params);
  res.json({ rows: has(req, 'vendors.view') ? rows : rows.map((row) => { const output = { ...row }; delete output.vendor_id; delete output.vendor_name; return output; }) });
}));
router.post('/tasks', requirePermission('tasks.manage'), validate('task'), asyncHandler(async (req, res) => {
  const p = req.validated; if (p.vendorId && !has(req, 'vendors.view')) throw httpError('Vendor-linked tasks require vendor access', 403, 'BUSINESS_PERMISSION_DENIED'); const id = crypto.randomUUID(); const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction(); await connection.execute(`INSERT INTO biz_crm_tasks
    (id,title,description,priority,status,due_at,assigned_user_id,client_id,vendor_id,sale_id,created_by)
    VALUES (:id,:title,:description,:priority,:status,:dueAt,:assigned,:clientId,:vendorId,:saleId,:actor)`,
    { id, title: p.title, description: p.description || null, priority: p.priority, status: p.status, dueAt: p.dueAt || null, assigned: assignedUser(req, p.assignedUserId), clientId: p.clientId || null, vendorId: p.vendorId || null, saleId: p.saleId || null, actor: actor(req) });
    await audit.write(connection, req, 'task.create', 'task', id, null, p); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const rows = await db.query('SELECT * FROM biz_crm_tasks WHERE id=:id', { id }); res.status(201).json(rows[0]);
}));
router.put('/tasks/:id', requirePermission('tasks.manage'), validate('task'), asyncHandler(async (req, res) => {
  const p = req.validated; if (p.vendorId && !has(req, 'vendors.view')) throw httpError('Vendor-linked tasks require vendor access', 403, 'BUSINESS_PERMISSION_DENIED'); const connection = await db.getPool().getConnection();
  try { await connection.beginTransaction(); const [before] = await connection.execute('SELECT * FROM biz_crm_tasks WHERE id=:id AND deleted_at IS NULL FOR UPDATE', { id: req.params.id });
    if (!before.length) throw httpError('Task not found', 404); staffTaskScope(req, before[0]); if (Number(before[0].version) !== Number(p.version)) throw httpError('Version conflict', 409, 'VERSION_CONFLICT');
    await connection.execute(`UPDATE biz_crm_tasks SET title=:title,description=:description,priority=:priority,status=:status,due_at=:dueAt,
      assigned_user_id=:assigned,client_id=:clientId,vendor_id=:vendorId,sale_id=:saleId,updated_by=:actor,version=version+1,
      completed_at=CASE WHEN :status='completed' THEN COALESCE(completed_at,NOW()) ELSE NULL END WHERE id=:id AND version=:version`,
    { title: p.title, description: p.description || null, priority: p.priority, status: p.status, dueAt: p.dueAt || null, assigned: assignedUser(req, p.assignedUserId), clientId: p.clientId || null, vendorId: p.vendorId || null, saleId: p.saleId || null, actor: actor(req), id: req.params.id, version: p.version });
    await audit.write(connection, req, 'task.update', 'task', req.params.id, before[0], p); await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const rows = await db.query('SELECT * FROM biz_crm_tasks WHERE id=:id', { id: req.params.id }); res.json(rows[0]);
}));
router.delete('/tasks/:id', requirePermission('tasks.manage'), asyncHandler(async (req, res) => {
  const rows = await db.query('SELECT * FROM biz_crm_tasks WHERE id=:id AND deleted_at IS NULL LIMIT 1', { id: req.params.id });
  if (!rows.length) throw httpError('Task not found', 404); staffTaskScope(req, rows[0]);
  await db.query('UPDATE biz_crm_tasks SET deleted_at=NOW(),updated_by=:actor,version=version+1 WHERE id=:id', { actor: actor(req), id: req.params.id });
  res.json({ id: req.params.id, deleted: true });
}));
router.post('/activities', requirePermission('activities.manage'), validate('activity'), asyncHandler(async (req, res) => {
  const p = req.validated; await assertActivityEntity(req, p.entityType, p.entityId); const id = crypto.randomUUID(); await db.query(`INSERT INTO biz_crm_activities (id,entity_type,entity_id,activity_type,subject,body,created_by)
    VALUES (:id,:entityType,:entityId,:activityType,:subject,:body,:actor)`, { id, entityType: p.entityType, entityId: p.entityId, activityType: p.activityType, subject: p.subject || null, body: p.body || null, actor: actor(req) }); res.status(201).json({ id, ...p });
}));
router.get('/activities', requirePermission('activities.view'), asyncHandler(async (req, res) => {
  const entityType = String(req.query.entityType || ''); const entityId = String(req.query.entityId || ''); await assertActivityEntity(req, entityType, entityId);
  const rows = await db.query('SELECT * FROM biz_crm_activities WHERE entity_type=:type AND entity_id=:id ORDER BY created_at DESC LIMIT 200', { type: entityType, id: entityId }); res.json({ rows });
}));
router.post('/reminders/prepare', requirePermission('reminders.prepare'), asyncHandler(async (req, res) => res.status(201).json(await reminders.prepare(req, req.body))));
router.post('/reminders/:id/opened', requirePermission('reminders.prepare'), asyncHandler(async (req, res) => res.json(await reminders.markOpened(req, req.params.id))));
router.get('/saved-views', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  const rows = await db.query('SELECT * FROM biz_crm_saved_views WHERE module_name=:module AND (user_id=:actor OR shared=1) ORDER BY shared DESC,name', { module: String(req.query.module || 'sales').slice(0, 40), actor: actor(req) }); res.json({ rows: rows.map((r) => ({ ...r, filters: JSON.parse(r.filters_json || '{}') })) });
}));
router.post('/saved-views', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  const moduleName = String(req.body.module || '').slice(0, 40); const name = String(req.body.name || '').trim().slice(0, 120); if (!moduleName || !name) throw httpError('View module and name are required'); const id = crypto.randomUUID();
  await db.query(`INSERT INTO biz_crm_saved_views (id,user_id,module_name,name,filters_json,shared) VALUES (:id,:actor,:module,:name,:filters,:shared)
    ON DUPLICATE KEY UPDATE filters_json=VALUES(filters_json),shared=VALUES(shared),updated_at=NOW()`, { id, actor: actor(req), module: moduleName, name, filters: JSON.stringify(req.body.filters || {}), shared: ['OWNER','ADMIN','MANAGER'].includes(req.businessAccess?.role) && req.body.shared ? 1 : 0 }); res.status(201).json({ id, module: moduleName, name });
}));
router.delete('/saved-views/:id', requirePermission('sales.view'), asyncHandler(async (req, res) => { await db.query('DELETE FROM biz_crm_saved_views WHERE id=:id AND user_id=:actor', { id: req.params.id, actor: actor(req) }); res.json({ id: req.params.id, deleted: true }); }));
module.exports = router;
