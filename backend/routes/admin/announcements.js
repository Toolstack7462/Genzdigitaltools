'use strict';
/**
 * Admin announcements — short notices shown to clients on their dashboard.
 * Mounted at /api/crm/admin/announcements. Admin-auth protected. No secrets.
 */
const express = require('express');
const router = express.Router();
const Announcement = require('../../models/Announcement');
const ActivityLog = require('../../models/ActivityLog');
const User = require('../../models/User');
const { requireAuth, requireAdmin } = require('../../middleware/authEnhanced');

router.use(requireAuth);
router.use(requireAdmin);

const LEVELS = ['info', 'success', 'warning'];

function dto(a) {
  const o = typeof a.toObject === 'function' ? a.toObject() : a;
  return {
    _id: o._id,
    title: o.title || '',
    body: o.body || '',
    level: LEVELS.includes(o.level) ? o.level : 'info',
    active: o.active !== false,
    // Targeting: clientId null/empty → shown to ALL clients; otherwise only to
    // that one client. clientLabel is stored at write time for display so the
    // admin list never needs an extra join.
    clientId: o.clientId || null,
    clientLabel: o.clientLabel || null,
    createdBy: o.createdBy || null,
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
  };
}

// Resolve a targeted client into { clientId, clientLabel } for storage, or the
// "all clients" shape. Returns null if a clientId was given but doesn't match a
// real client (caller treats that as a validation error).
async function resolveTarget(clientId) {
  if (!clientId) return { clientId: null, clientLabel: null };
  const u = await User.findOne({ _id: clientId, role: 'CLIENT' }).select('fullName email');
  if (!u) return null;
  return { clientId: String(u._id), clientLabel: u.fullName || u.email || 'Client' };
}

// GET / — all announcements (newest first)
router.get('/', async (req, res) => {
  try {
    const rows = await Announcement.find({}).sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, announcements: (rows || []).map(dto) });
  } catch (e) {
    console.error('List announcements error:', e.message);
    res.status(500).json({ error: 'Failed to list announcements' });
  }
});

// POST / — create
router.post('/', async (req, res) => {
  try {
    const { title, body, level, active, clientId } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
    const target = await resolveTarget(clientId);
    if (target === null) return res.status(400).json({ error: 'Target client not found' });
    const a = await Announcement.create({
      title: String(title).trim().slice(0, 160),
      body: String(body || '').trim().slice(0, 2000),
      level: LEVELS.includes(level) ? level : 'info',
      active: active !== false,
      clientId: target.clientId,
      clientLabel: target.clientLabel,
      createdBy: req.userId,
    });
    await ActivityLog.log('ADMIN', req.userId, 'ANNOUNCEMENT_CREATED', { announcementId: a._id, targeted: !!target.clientId });
    res.status(201).json({ success: true, announcement: dto(a) });
  } catch (e) {
    console.error('Create announcement error:', e.message);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

// PATCH /:id — update fields and/or toggle active
router.patch('/:id', async (req, res) => {
  try {
    const a = await Announcement.findById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Announcement not found' });
    const { title, body, level, active, clientId } = req.body;
    if (title !== undefined) a.title = String(title).trim().slice(0, 160);
    if (body !== undefined) a.body = String(body).trim().slice(0, 2000);
    if (level !== undefined && LEVELS.includes(level)) a.level = level;
    if (active !== undefined) a.active = !!active;
    if (clientId !== undefined) {
      const target = await resolveTarget(clientId);
      if (target === null) return res.status(400).json({ error: 'Target client not found' });
      a.clientId = target.clientId;
      a.clientLabel = target.clientLabel;
    }
    await a.save();
    await ActivityLog.log('ADMIN', req.userId, 'ANNOUNCEMENT_UPDATED', { announcementId: a._id, active: a.active });
    res.json({ success: true, announcement: dto(a) });
  } catch (e) {
    console.error('Update announcement error:', e.message);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const a = await Announcement.findById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Announcement not found' });
    await a.deleteOne();
    await ActivityLog.log('ADMIN', req.userId, 'ANNOUNCEMENT_DELETED', { announcementId: req.params.id });
    res.json({ success: true });
  } catch (e) {
    console.error('Delete announcement error:', e.message);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

module.exports = router;
