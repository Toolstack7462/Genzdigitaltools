const express = require('express');
const router = express.Router();
const NotificationState = require('../../models/NotificationState');
const { requireAuth, requireRole } = require('../../middleware/authEnhanced');

// Apply auth middleware
router.use(requireAuth);
router.use(requireRole('CLIENT'));

// POST /api/client/notifications/dismiss - Dismiss notification
router.post('/dismiss', async (req, res) => {
  try {
    const { assignmentId, type, mode } = req.body;
    
    if (!assignmentId || !type || !mode) {
      return res.status(400).json({ error: 'Assignment ID, type, and mode are required' });
    }
    
    if (!['later', 'dismiss'].includes(mode)) {
      return res.status(400).json({ error: 'Mode must be "later" or "dismiss"' });
    }
    
    const update = {};
    
    if (mode === 'later') {
      // Dismiss for 24 hours
      const dismissedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
      update.dismissedUntil = dismissedUntil;
      update.dismissed = false;
    } else if (mode === 'dismiss') {
      // Dismiss permanently
      update.dismissed = true;
      update.dismissedUntil = null;
    }
    
    await NotificationState.findOneAndUpdate(
      {
        clientId: req.userId,
        assignmentId,
        type
      },
      { $set: update },
      { upsert: true, new: true }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Dismiss notification error:', error);
    res.status(500).json({ error: 'Failed to dismiss notification' });
  }
});

module.exports = router;
