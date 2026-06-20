const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const DeviceBinding = require('../../models/DeviceBinding');
const ActivityLog = require('../../models/ActivityLog');
const Tool = require('../../models/Tool');
const Announcement = require('../../models/Announcement');
const { requireAuth, requireRole } = require('../../middleware/authEnhanced');

// Apply auth middleware
router.use(requireAuth);
router.use(requireRole('CLIENT'));

// GET /api/client/profile - Get client profile
router.get('/profile', async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET /api/client/device-info - Get device binding info
router.get('/device-info', async (req, res) => {
  try {
    const device = await DeviceBinding.findOne({ clientId: req.userId });
    res.json({ device });
  } catch (error) {
    console.error('Get device info error:', error);
    res.status(500).json({ error: 'Failed to fetch device info' });
  }
});

// GET /api/crm/client/activity - the signed-in client's OWN recent activity
// (logins, tool opens) for transparency. Scoped strictly to req.userId; never
// returns another user's data, and the payload carries no cookies/tokens/secrets.
router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 15));
    const cutoff = new Date(Date.now() - days * 86400000);
    // Only client-meaningful events: sign-ins, blocked/failed sign-ins, tools opened
    // (via the extension), and device resets. Excludes internal extension noise like
    // EXTENSION_SCAN_SUBMITTED / EXTENSION_CREDENTIALS_FETCH / EXTENSION_AUTH.
    const SHOW = /^(CLIENT_LOGIN|LOGIN_BLOCKED|TOOL_OPENED|DEVICE_RESET)/i;
    const all = await ActivityLog.find({ actorId: req.userId }).sort({ createdAt: -1 }).limit(300);
    const rows = (all || [])
      .filter(l => SHOW.test(String(l.action || '')) && l.createdAt && new Date(l.createdAt) >= cutoff)
      .slice(0, limit);
    // Resolve tool names for TOOL_OPENED entries (one bounded lookup), so the client
    // sees "Opened HIX AI" rather than a raw id. No secrets in the payload.
    const toolIds = [...new Set((rows || []).map(l => l.meta && l.meta.toolId).filter(Boolean).map(String))];
    const nameById = {};
    if (toolIds.length) {
      const tools = await Tool.find({ _id: { $in: toolIds } }).select('name').catch(() => []);
      (tools || []).forEach(t => { nameById[String(t._id)] = t.name; });
    }
    const activity = (rows || []).map(l => {
      const tid = (l.meta && l.meta.toolId) || null;
      return {
        _id: l._id,
        action: l.action,
        createdAt: l.createdAt,
        toolId: tid,
        toolName: tid ? (nameById[String(tid)] || null) : null,
      };
    });
    res.json({ success: true, activity });
  } catch (error) {
    console.error('Get client activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// PUT /api/crm/client/profile - client updates their OWN display name only.
router.put('/profile', async (req, res) => {
  try {
    const { fullName } = req.body;
    if (!fullName || String(fullName).trim().length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }
    const user = await User.findById(req.userId);
    if (!user || user.role !== 'CLIENT') return res.status(404).json({ error: 'User not found' });
    user.fullName = String(fullName).trim().slice(0, 100);
    await user.save();
    await ActivityLog.log('CLIENT', req.userId, 'PROFILE_UPDATED', {});
    res.json({ success: true, user: user.toJSON() });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/crm/client/change-password - verify current password, set a new one.
// Never logs either password. Keeps the current session valid.
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
    if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const user = await User.findById(req.userId); // needs passwordHash → no select()
    if (!user || user.role !== 'CLIENT') return res.status(404).json({ error: 'User not found' });
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
    user.passwordHash = newPassword; // User.preSave bcrypt-hashes it
    await user.save();
    await ActivityLog.log('CLIENT', req.userId, 'PASSWORD_CHANGED', {});
    res.json({ success: true, message: 'Password updated' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// GET /api/crm/client/announcements - active admin announcements for clients.
// Read-only; only published (active) items; never exposes drafts or internal fields.
router.get('/announcements', async (req, res) => {
  try {
    const rows = await Announcement.find({ active: true }).sort({ createdAt: -1 }).limit(20);
    const announcements = (rows || []).map(a => ({
      _id: a._id,
      title: a.title || '',
      body: a.body || '',
      level: a.level || 'info',
      createdAt: a.createdAt,
    }));
    res.json({ success: true, announcements });
  } catch (error) {
    console.error('Get announcements error:', error);
    res.json({ success: true, announcements: [] }); // fail-safe: never break the dashboard
  }
});

module.exports = router;
