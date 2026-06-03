const express = require('express');
const router = express.Router();
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireRole } = require('../../middleware/authEnhanced');

// Apply auth middleware - accept all admin roles
router.use(requireAuth);
router.use((req, res, next) => {
  const adminRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
  if (!adminRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
});

// GET /api/admin/activity - Get activity logs
router.get('/', async (req, res) => {
  try {
    const { 
      limit = 20, 
      page = 1, 
      action, 
      role,
      startDate,
      endDate 
    } = req.query;
    
    const query = {};
    if (action) query.action = action;
    if (role) query.actorRole = role;
    
    // Date range filter
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const activities = await ActivityLog.find(query)
      .populate('actorId', 'fullName email role')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(skip);
    
    const total = await ActivityLog.countDocuments(query);
    
    res.json({ 
      activities,
      total,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Get activity logs error:', error);
    res.status(500).json({ error: 'Failed to fetch activity logs' });
  }
});

module.exports = router;
