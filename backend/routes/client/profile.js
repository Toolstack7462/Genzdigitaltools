const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const DeviceBinding = require('../../models/DeviceBinding');
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

module.exports = router;
