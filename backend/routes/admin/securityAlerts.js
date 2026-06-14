/**
 * routes/admin/securityAlerts.js
 *
 * Admin Security Alerts API.
 * All routes require ADMIN or SUPER_ADMIN role (enforced by requireAdmin).
 */
'use strict';

const express       = require('express');
const router        = express.Router();
const SecurityAlert = require('../../models/SecurityAlert');
const ExtensionScan = require('../../models/ExtensionScan');
const DeviceProfile = require('../../models/DeviceProfile');
const User          = require('../../models/User');
const ExtensionToken = require('../../models/ExtensionToken');
const RefreshToken  = require('../../models/RefreshToken');
const ActivityLog   = require('../../models/ActivityLog');
const DeviceBinding = require('../../models/DeviceBinding');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');

router.use(requireAuth);
router.use(requireAdmin);

// ── Helpers ──────────────────────────────────────────────────────────────────
function safePagination(q) {
  const page  = Math.max(1, parseInt(q.page,  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25));
  return { page, limit, skip: (page - 1) * limit };
}

// ── GET /api/crm/admin/security-alerts — list alerts ─────────────────────────
router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = safePagination(req.query);
    const { status, riskLevel, riskType, clientId } = req.query;

    const filter = {};
    if (status)    filter.status    = status;
    if (riskLevel) filter.riskLevel = riskLevel;
    if (riskType)  filter.riskType  = riskType;
    if (clientId)  filter.clientId  = clientId;

    const [alerts, total] = await Promise.all([
      SecurityAlert.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip).limit(limit)
        .populate('clientId', 'fullName email status')
        .populate('context.toolId', 'name')
        .populate('reviewedBy', 'fullName')
        .lean(),
      SecurityAlert.countDocuments(filter),
    ]);

    // Stats for the dashboard header
    const [openCount, highCount, todayCount] = await Promise.all([
      SecurityAlert.countDocuments({ status: 'open' }),
      SecurityAlert.countDocuments({ status: 'open', riskLevel: { $in: ['high', 'critical'] } }),
      SecurityAlert.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
    ]);

    res.json({ alerts, total, page, limit, stats: { openCount, highCount, todayCount } });
  } catch (err) {
    console.error('[securityAlerts GET /]', err);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// ── GET /api/crm/admin/security-alerts/scans — extension scanner reports ──────
// One row per client (latest scan). Registered BEFORE /:id so "scans" is not
// captured as an :id param.
router.get('/scans', async (req, res) => {
  try {
    const { page, limit, skip } = safePagination(req.query);
    const { riskLevel, q } = req.query;

    let scans = await ExtensionScan.find({})
      .sort({ scannedAt: -1 })
      .populate('clientId', 'fullName email status')
      .lean();
    scans = Array.isArray(scans) ? scans : [];

    // Optional filters (applied in-memory — scan set is one-per-client, small).
    if (riskLevel) {
      scans = scans.filter(s => (s.counts?.[riskLevel] || 0) > 0);
    }
    if (q) {
      const needle = String(q).toLowerCase();
      scans = scans.filter(s =>
        (s.clientEmail || s.clientId?.email || '').toLowerCase().includes(needle) ||
        (s.clientName  || s.clientId?.fullName || '').toLowerCase().includes(needle)
      );
    }

    const total = scans.length;
    const paged = scans.slice(skip, skip + limit);

    const stats = {
      clients:        total,
      withRisky:      scans.filter(s => (s.counts?.risky || 0) > 0).length,
      withHigh:       scans.filter(s => (s.counts?.high  || 0) > 0).length,
      permissionMissing: scans.filter(s => s.scannerStatus === 'permission_missing').length,
    };

    res.json({ scans: paged, total, page, limit, stats });
  } catch (err) {
    console.error('[securityAlerts GET /scans]', err);
    res.status(500).json({ error: 'Failed to fetch extension scans' });
  }
});

// ── GET /api/crm/admin/security-alerts/devices — client device profiles ──────
// Registered BEFORE /:id so "devices" isn't captured as an :id param.
router.get('/devices', async (req, res) => {
  try {
    const { page, limit, skip } = safePagination(req.query);
    const { status, q } = req.query;

    let devices = await DeviceProfile.find({})
      .sort({ lastSeenAt: -1 })
      .populate('clientId', 'fullName email status')
      .lean();
    devices = Array.isArray(devices) ? devices : [];

    if (status) devices = devices.filter(d => d.status === status);
    if (q) {
      const needle = String(q).toLowerCase();
      devices = devices.filter(d =>
        (d.clientEmail || d.clientId?.email || '').toLowerCase().includes(needle) ||
        (d.clientId?.fullName || '').toLowerCase().includes(needle)
      );
    }

    const total = devices.length;
    const paged = devices.slice(skip, skip + limit).map(d => ({
      ...d,
      browserCount: Array.isArray(d.browserInstanceIds) ? d.browserInstanceIds.length : 0,
    }));
    const stats = {
      total,
      approved: devices.filter(d => d.status === 'approved').length,
      pending:  devices.filter(d => d.status === 'pending').length,
      blocked:  devices.filter(d => d.status === 'blocked').length,
    };

    res.json({ devices: paged, total, page, limit, stats });
  } catch (err) {
    console.error('[securityAlerts GET /devices]', err);
    res.status(500).json({ error: 'Failed to fetch device profiles' });
  }
});

// ── POST /api/crm/admin/security-alerts/devices/:id/:action — approve|block ──
router.post('/devices/:id/:action', async (req, res) => {
  try {
    const { id, action } = req.params;
    const STATUS = { approve: 'approved', block: 'blocked', unblock: 'approved', pending: 'pending' };
    if (!STATUS[action]) return res.status(400).json({ error: 'Invalid action' });

    const device = await DeviceProfile.findById(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    device.status = STATUS[action];
    device.reviewedBy = req.user._id;
    device.reviewedAt = new Date();
    await device.save();

    await ActivityLog.log('ADMIN', req.user._id, 'DEVICE_PROFILE_' + action.toUpperCase(), {
      targetClientId: device.clientId, deviceProfileId: device._id, newStatus: device.status,
    });

    res.json({ success: true, device });
  } catch (err) {
    console.error('[securityAlerts POST /devices action]', err);
    res.status(500).json({ error: 'Action failed: ' + err.message });
  }
});

// ── GET /api/crm/admin/security-alerts/:id — single alert ────────────────────
router.get('/:id', async (req, res) => {
  try {
    const alert = await SecurityAlert.findById(req.params.id)
      .populate('clientId', 'fullName email status lastLoginAt lastLoginIp')
      .populate('context.toolId', 'name targetUrl')
      .populate('reviewedBy', 'fullName')
      .lean();
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json({ alert });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch alert' });
  }
});

// ── POST /api/crm/admin/security-alerts/:id/action — take action ─────────────
router.post('/:id/action', async (req, res) => {
  try {
    const { action, notes } = req.body;
    const VALID_ACTIONS = ['token_revoked', 'client_logged_out', 'device_reset', 'client_disabled', 'marked_false_positive', 'reviewed'];

    if (!action || !VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const alert = await SecurityAlert.findById(req.params.id).populate('clientId');
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    const clientId = alert.clientId?._id || alert.clientId;

    // ── Execute the requested action ─────────────────────────────────────────
    switch (action) {
      case 'token_revoked': {
        // Revoke all active extension tokens for this client
        await ExtensionToken.updateMany(
          { clientId, isRevoked: false },
          { $set: { isRevoked: true } }
        );
        await ActivityLog.log('ADMIN', req.user._id, 'ADMIN_ACTION_REVOKE_EXT_TOKEN', {
          targetClientId: clientId, alertId: alert._id,
        });
        break;
      }
      case 'client_logged_out': {
        // Force logout: increment tokenVersion (invalidates all JWT access tokens)
        const user = await User.findById(clientId);
        if (user) await user.forceLogout();
        // Also revoke all refresh tokens
        await RefreshToken.updateMany(
          { userId: clientId, revokedAt: null },
          { $set: { revokedAt: new Date() } }
        );
        await ActivityLog.log('ADMIN', req.user._id, 'ADMIN_ACTION_FORCE_LOGOUT', {
          targetClientId: clientId, alertId: alert._id,
        });
        break;
      }
      case 'device_reset': {
        // Remove device bindings so the client re-binds on next login
        // DeviceBinding already in scope
        await DeviceBinding.deleteMany({ clientId });
        await ActivityLog.log('ADMIN', req.user._id, 'ADMIN_ACTION_DEVICE_RESET', {
          targetClientId: clientId, alertId: alert._id,
        });
        break;
      }
      case 'client_disabled': {
        await User.findByIdAndUpdate(clientId, { status: 'disabled' });
        // Revoke all tokens too
        await ExtensionToken.updateMany({ clientId }, { $set: { isRevoked: true } });
        await ActivityLog.log('ADMIN', req.user._id, 'ADMIN_ACTION_DISABLE_CLIENT', {
          targetClientId: clientId, alertId: alert._id,
        });
        break;
      }
      case 'marked_false_positive':
        alert.status = 'false_positive';
        break;
      case 'reviewed':
        alert.status = 'reviewed';
        break;
    }

    // Update alert record
    if (action !== 'reviewed' && action !== 'marked_false_positive') {
      alert.status = 'resolved';
    }
    alert.reviewedBy  = req.user._id;
    alert.reviewedAt  = new Date();
    alert.reviewNotes = notes || '';
    alert.actionTaken = action === 'reviewed' ? 'none' : action;
    await alert.save();

    res.json({ success: true, alert });
  } catch (err) {
    console.error('[securityAlerts POST action]', err);
    res.status(500).json({ error: 'Action failed: ' + err.message });
  }
});

// ── POST /api/crm/admin/security-alerts/:id/review — mark reviewed ────────────
router.post('/:id/review', async (req, res) => {
  try {
    const alert = await SecurityAlert.findByIdAndUpdate(
      req.params.id,
      {
        status: 'reviewed',
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        reviewNotes: req.body.notes || '',
        actionTaken: 'none',
      },
      { new: true }
    );
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json({ success: true, alert });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark reviewed' });
  }
});

// ── GET /api/crm/admin/security-alerts/summary — counts by type/level ─────────
router.get('/stats/summary', async (req, res) => {
  try {
    const [byLevel, byType, recentTrend] = await Promise.all([
      SecurityAlert.aggregate([
        { $match: { status: 'open' } },
        { $group: { _id: '$riskLevel', count: { $sum: 1 } } },
      ]),
      SecurityAlert.aggregate([
        { $match: { status: 'open' } },
        { $group: { _id: '$riskType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      SecurityAlert.aggregate([
        { $match: { createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } } },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          }
        },
        { $sort: { _id: 1 } },
      ]),
    ]);
    res.json({ byLevel, byType, recentTrend });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

module.exports = router;
