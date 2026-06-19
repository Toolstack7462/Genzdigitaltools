const express = require('express');
const router = express.Router();
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireRole } = require('../../middleware/authEnhanced');

// 7-day retention for routine activity, applied lazily (throttled to once/hour) so the
// log table never grows unbounded — important security/payment/account/credential
// audit logs are preserved (see ActivityLog.purgeOld). Runs in the background; never
// blocks or fails the request.
const RETENTION_DAYS = Number(process.env.ACTIVITY_RETENTION_DAYS || 7);
let lastPurgeAt = 0;
function maybePurge() {
  const now = Date.now();
  if (now - lastPurgeAt < 60 * 60 * 1000) return;
  lastPurgeAt = now;
  Promise.resolve().then(() => ActivityLog.purgeOld(RETENTION_DAYS)).catch(() => {});
}

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
    maybePurge(); // lazy 7-day retention (throttled, non-blocking)
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
