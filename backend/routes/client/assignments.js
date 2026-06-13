// ============================================================
// DEPRECATED: This file is superseded by its Enhanced version.
// DO NOT IMPORT this file in new code. It will be deleted.
// See the corresponding *Enhanced.js or server-crm.js file.
// ============================================================

const express = require('express');
const router = express.Router();
const ToolAssignment = require('../../models/ToolAssignment');
const NotificationState = require('../../models/NotificationState');
const { requireAuth, requireRole } = require('../../middleware/authEnhanced');

// Apply auth middleware
router.use(requireAuth);
router.use(requireRole('CLIENT'));

// GET /api/client/assignments/expiring - Get expiring assignments
router.get('/expiring', async (req, res) => {
  try {
    const { days = 3 } = req.query;
    
    const now = new Date();
    const futureDate = new Date(now.getTime() + parseInt(days) * 24 * 60 * 60 * 1000);
    
    // Find assignments expiring within specified days
    const assignments = await ToolAssignment.find({
      clientId: req.userId,
      status: 'active',
      endDate: {
        $gte: now,
        $lte: futureDate
      }
    }).populate('toolId', 'name category');
    
    // Check notification states
    const expiring = [];
    for (const assignment of assignments) {
      const notificationState = await NotificationState.findOne({
        clientId: req.userId,
        assignmentId: assignment._id,
        type: 'EXPIRY_3D'
      });
      
      // Skip if dismissed permanently
      if (notificationState && notificationState.dismissed) continue;
      
      // Skip if dismissed temporarily and still within grace period
      if (notificationState && notificationState.dismissedUntil) {
        if (new Date(notificationState.dismissedUntil) > now) continue;
      }
      
      const daysLeft = Math.ceil((assignment.endDate - now) / (24 * 60 * 60 * 1000));
      
      expiring.push({
        assignmentId: assignment._id,
        tool: assignment.toolId,
        endDate: assignment.endDate,
        daysLeft
      });
    }
    
    res.json({ expiring });
  } catch (error) {
    console.error('Get expiring assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch expiring assignments' });
  }
});

module.exports = router;
