const express = require('express');
const router = express.Router();
const ToolAssignment = require('../../models/ToolAssignment');
const ExpiryDismissal = require('../../models/ExpiryDismissal');
const User = require('../../models/User');
const { requireAuth, requireRole } = require('../../middleware/authEnhanced');

// Apply auth middleware
router.use(requireAuth);
router.use(requireRole('CLIENT'));

// GET /api/crm/client/assignments/expiring - Get expiring assignments
router.get('/expiring', async (req, res) => {
  try {
    const client = await User.findById(req.userId);
    const warningDays = client.expirySettings?.warningDays || 3;
    
    const now = new Date();
    const warningDate = new Date();
    warningDate.setDate(warningDate.getDate() + warningDays);
    
    // Find assignments expiring within warning days
    const expiringAssignments = await ToolAssignment.find({
      clientId: req.userId,
      status: 'active',
      endDate: {
        $gte: now,
        $lte: warningDate
      }
    }).populate('toolId', 'name category description');
    
    // Get dismissals
    const dismissals = await ExpiryDismissal.find({
      clientId: req.userId,
      assignmentId: { $in: expiringAssignments.map(a => a._id) }
    });
    
    // Filter out dismissed assignments
    const dismissalMap = new Map(dismissals.map(d => [d.assignmentId.toString(), d]));
    const activeWarnings = expiringAssignments.filter(assignment => {
      const dismissal = dismissalMap.get(assignment._id.toString());
      if (!dismissal) return true;
      if (dismissal.dontShowAgain) return false;
      
      // Show again after 24 hours
      const hoursSinceDismissal = (now - dismissal.dismissedAt) / (1000 * 60 * 60);
      return hoursSinceDismissal >= 24;
    });
    
    // Calculate days left for each
    const withDaysLeft = activeWarnings.map(assignment => {
      const daysLeft = Math.ceil((assignment.endDate - now) / (1000 * 60 * 60 * 24));
      return {
        ...assignment.toObject(),
        tool: assignment.toolId,
        daysLeft
      };
    });
    
    res.json({
      success: true,
      expiring: withDaysLeft,
      warningDays
    });
  } catch (error) {
    console.error('Get expiring assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch expiring assignments' });
  }
});

// POST /api/crm/client/assignments/:id/dismiss - Dismiss expiry warning
router.post('/:id/dismiss', async (req, res) => {
  try {
    const { dontShowAgain } = req.body;
    
    // Check if assignment belongs to client
    const assignment = await ToolAssignment.findOne({
      _id: req.params.id,
      clientId: req.userId
    });
    
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    
    // Create or update dismissal
    await ExpiryDismissal.findOneAndUpdate(
      {
        clientId: req.userId,
        assignmentId: assignment._id
      },
      {
        dismissedAt: new Date(),
        dontShowAgain: dontShowAgain || false
      },
      {
        upsert: true,
        new: true
      }
    );
    
    res.json({
      success: true,
      message: dontShowAgain 
        ? 'You will not see warnings for this tool again' 
        : 'Warning dismissed for 24 hours'
    });
  } catch (error) {
    console.error('Dismiss warning error:', error);
    res.status(500).json({ error: 'Failed to dismiss warning' });
  }
});

module.exports = router;
