'use strict';
/**
 * Admin follow-up reminders — a simple CRM task list (NOT a calendar system).
 * Mounted at /api/crm/admin/reminders. Admin-auth protected. Never logs or returns
 * cookies/tokens/sessions/secrets — only title/note/dueDate/status + client name.
 */
const express = require('express');
const router = express.Router();
const Reminder = require('../../models/Reminder');
const User = require('../../models/User');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireAdmin } = require('../../middleware/authEnhanced');

router.use(requireAuth);
router.use(requireAdmin);

function dto(r, userMap) {
  const o = typeof r.toObject === 'function' ? r.toObject() : r;
  const u = userMap && o.clientId ? userMap[String(o.clientId)] : null;
  return {
    _id: o._id,
    clientId: o.clientId || null,
    client: u ? { _id: u._id, fullName: u.fullName, email: u.email } : null,
    title: o.title || '',
    note: o.note || '',
    dueDate: o.dueDate || null,
    status: o.status || 'pending',
    createdBy: o.createdBy || null,
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
  };
}

async function resolveClients(rows) {
  const ids = [...new Set(rows.map(r => r.clientId && String(r.clientId)).filter(Boolean))];
  const map = {};
  if (ids.length) {
    const users = await User.find({ _id: { $in: ids } }).select('fullName email').catch(() => []);
    (users || []).forEach(u => { map[String(u._id)] = u; });
  }
  return map;
}

// GET / — list. Filters: clientId, status, scope (due|overdue|upcoming|pending|all).
router.get('/', async (req, res) => {
  try {
    const { clientId, status, scope } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const q = {};
    if (clientId) q.clientId = clientId;
    if (status) q.status = status;

    let rows = await Reminder.find(q).sort({ dueDate: 1 });

    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
    if (scope === 'due') {
      rows = rows.filter(r => r.status === 'pending' && r.dueDate && new Date(r.dueDate) <= endToday);
    } else if (scope === 'overdue') {
      rows = rows.filter(r => r.status === 'pending' && r.dueDate && new Date(r.dueDate) < startToday);
    } else if (scope === 'upcoming') {
      rows = rows.filter(r => r.status === 'pending' && r.dueDate && new Date(r.dueDate) > endToday);
    } else if (scope === 'pending') {
      rows = rows.filter(r => r.status === 'pending');
    }

    const userMap = await resolveClients(rows);
    const total = rows.length;
    const paged = rows.slice((page - 1) * limit, (page - 1) * limit + limit);
    return res.json({ success: true, reminders: paged.map(r => dto(r, userMap)), total, page, limit });
  } catch (e) {
    console.error('List reminders error:', e.message);
    return res.status(500).json({ error: 'Failed to list reminders' });
  }
});

// POST / — create
router.post('/', async (req, res) => {
  try {
    const { clientId, title, note, dueDate } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
    const r = await Reminder.create({
      clientId: clientId || null,
      title: String(title).trim().slice(0, 160),
      note: String(note || '').trim().slice(0, 1000),
      dueDate: dueDate ? new Date(dueDate) : null,
      status: 'pending',
      createdBy: req.userId,
    });
    await ActivityLog.log('ADMIN', req.userId, 'REMINDER_CREATED', { reminderId: r._id, clientId: clientId || null });
    return res.status(201).json({ success: true, reminder: dto(r) });
  } catch (e) {
    console.error('Create reminder error:', e.message);
    return res.status(500).json({ error: 'Failed to create reminder' });
  }
});

// PATCH /:id — update status and/or fields
router.patch('/:id', async (req, res) => {
  try {
    const r = await Reminder.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Reminder not found' });
    const { status, title, note, dueDate } = req.body;
    if (status !== undefined) {
      if (!['pending', 'done', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      r.status = status;
    }
    if (title !== undefined) r.title = String(title).trim().slice(0, 160);
    if (note !== undefined) r.note = String(note).trim().slice(0, 1000);
    if (dueDate !== undefined) r.dueDate = dueDate ? new Date(dueDate) : null;
    await r.save();
    await ActivityLog.log('ADMIN', req.userId, 'REMINDER_UPDATED', { reminderId: r._id, status: r.status });
    return res.json({ success: true, reminder: dto(r) });
  } catch (e) {
    console.error('Update reminder error:', e.message);
    return res.status(500).json({ error: 'Failed to update reminder' });
  }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const r = await Reminder.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Reminder not found' });
    await r.deleteOne();
    await ActivityLog.log('ADMIN', req.userId, 'REMINDER_DELETED', { reminderId: req.params.id });
    return res.json({ success: true });
  } catch (e) {
    console.error('Delete reminder error:', e.message);
    return res.status(500).json({ error: 'Failed to delete reminder' });
  }
});

module.exports = router;
