const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const DeviceBinding = require('../../models/DeviceBinding');
const ActivityLog = require('../../models/ActivityLog');
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
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 15));
    const rows = await ActivityLog.find({ actorId: req.userId }).sort({ createdAt: -1 }).limit(limit);
    const activity = (rows || []).map(l => ({
      _id: l._id,
      action: l.action,
      createdAt: l.createdAt,
      toolId: (l.meta && l.meta.toolId) || null,
    }));
    res.json({ success: true, activity });
  } catch (error) {
    console.error('Get client activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
