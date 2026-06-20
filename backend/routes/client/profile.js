const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const DeviceBinding = require('../../models/DeviceBinding');
const ActivityLog = require('../../models/ActivityLog');
const Tool = require('../../models/Tool');
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

module.exports = router;
