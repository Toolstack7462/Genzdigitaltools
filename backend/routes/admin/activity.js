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
      endDate,
      search
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

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 20);
    const term = String(search || '').trim().toLowerCase();

    // Fetch the structured-filter matches, then apply free-text search across the
    // FULL result set (action / role / actor email+name / meta) before paginating —
    // otherwise search would only match the current page. The table is bounded by the
    // 7-day retention, so a full scan here is cheap. Never exposes secrets (meta only).
    let matched = await ActivityLog.find(query)
      .populate('actorId', 'fullName email role')
      .sort({ createdAt: -1 });

    if (term) {
      matched = matched.filter((a) => {
        const actor = a.actorId && typeof a.actorId === 'object' ? a.actorId : null;
        const haystack = [
          a.action,
          a.actorRole,
          actor?.email,
          actor?.fullName,
          a.meta ? JSON.stringify(a.meta) : '',
        ].join(' ').toLowerCase();
        return haystack.includes(term);
      });
    }

    const total = matched.length;
    const skip = (pageNum - 1) * limitNum;
    const activities = matched.slice(skip, skip + limitNum);

    res.json({
      activities,
      total,
      page: pageNum,
      limit: limitNum
    });
  } catch (error) {
    console.error('Get activity logs error:', error);
    res.status(500).json({ error: 'Failed to fetch activity logs' });
  }
});

module.exports = router;
